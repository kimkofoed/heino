import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

dotenv.config();

const { OPENAI_API_KEY, WEBHOOK_URL, SYSTEM_MESSAGE } = process.env;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OpenAI API key.');
  process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const sessions = new Map();
const INACTIVITY_TIMEOUT = 20000; // 20 sekunders tavshed = afslutning

// ===== 🌍 STATUS ROUTES =====
fastify.get('/', async (_, reply) => {
  reply.send({
    status: 'ok',
    message: 'Twilio + OpenAI voice server is running 🚀',
    time: new Date().toISOString(),
  });
});

fastify.get('/health', async (_, reply) => {
  reply.send({ ok: true });
});

// ===== TWILIO ENTRY =====
fastify.all('/voice', async (req, reply) => {
  console.log('📞 Incoming call detected');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="da-DK"></Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml.trim());
});

// ===== MEDIA STREAM HANDLER =====
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (conn, req) => {
    const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
    console.log(`🧩 Twilio connected: ${sessionId}`);

    const session = {
      id: sessionId,
      transcript: '',
      streamSid: null,
      inactivityTimer: null,
      greeted: false,
      openAiReady: false,
      twilioReady: false,
    };

    sessions.set(sessionId, session);
    connectToOpenAI(conn, session);
  });
});

// ===== CONNECT TO OPENAI REALTIME =====
function connectToOpenAI(conn, session) {
  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  const resetInactivityTimer = () => {
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    session.inactivityTimer = setTimeout(() => {
      console.log('⏳ Tavshed – afslutter opkald...');
      gracefulHangup(conn, session, 'Inaktivitet');
    }, INACTIVITY_TIMEOUT);
  };

  const sendSessionUpdate = (autoStart = true) => {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        turn_detection: autoStart ? { type: 'none' } : { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: VOICE,
        modalities: ['text', 'audio'],
        temperature: 0.8,
        instructions:
          SYSTEM_MESSAGE ||
          'Du er en dansk receptionist. Tal venligt, professionelt og grammatisk korrekt dansk. Forstå danske navne og stednavne. Afslut samtalen høfligt, når det er naturligt.',
        input_audio_transcription: { model: 'whisper-1' },
      },
    };
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  const sendGreeting = () => {
    if (session.greeted) return;
    if (!session.twilioReady || !session.openAiReady) {
      console.log('⚠️ Afventer klarhed før greeting...');
      return;
    }
    session.greeted = true;
    console.log('🎙️ Sender dansk hilsen...');
    const greeting = {
      type: 'response.create',
      response: {
        instructions:
          'Sig venligt på dansk: "Hej, du taler med Ava fra Dirty Ranch Steakhouse. Hvordan kan jeg hjælpe dig i dag?"',
        modalities: ['audio'],
        voice: VOICE,
      },
    };
    openAiWs.send(JSON.stringify(greeting));
  };

  const sendFarewell = async () => {
    console.log('💬 Ava siger farvel...');
    const farewell = {
      type: 'response.create',
      response: {
        instructions:
          'Sig venligt på dansk: "Det var en fornøjelse at hjælpe dig. Tak fordi du ringede, og ha’ en rigtig god dag!"',
        modalities: ['audio'],
        voice: VOICE,
      },
    };
    openAiWs.send(JSON.stringify(farewell));
    setTimeout(() => endCall(conn, session, 'Farvel'), 3500);
  };

  // ====== OPENAI WEBSOCKET HANDLERS ======
  openAiWs.on('open', () => {
    console.log('✅ Forbundet til OpenAI Realtime API');
    setTimeout(() => sendSessionUpdate(true), 300);
  });

  openAiWs.on('message', (data) => {
    try {
      const event = JSON.parse(data);

      if (event.type === 'session.created') {
        session.openAiReady = true;
        console.log('🟢 OpenAI session klar');
        if (session.twilioReady && !session.greeted) setTimeout(sendGreeting, 400);
      }

      if (event.type === 'response.audio.delta') {
        const audio = {
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: Buffer.from(event.delta, 'base64').toString('base64') },
        };
        conn.send(JSON.stringify(audio));
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const userText = event.transcript.trim();
        session.transcript += `User: ${userText}\n`;
        console.log(`👤 ${session.id}: ${userText}`);
        resetInactivityTimer();
      }

      if (event.type === 'response.done') {
        const text =
          event.response.output?.[0]?.content?.find((c) => c.transcript)?.transcript?.trim() || '';
        if (text) {
          session.transcript += `Bot: ${text}\n`;
          console.log(`🤖 ${session.id}: ${text}`);
        }

        // AI afslutter selv
        if (text.match(/\b(farvel|hej hej|tak for i dag|det var det hele|tak skal du have)\b/i)) {
          sendFarewell();
        }
      }
    } catch (err) {
      console.error('⚠️ Fejl i OpenAI-besked:', err);
    }
  });

  // ====== TWILIO → OPENAI ======
  conn.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      switch (data.event) {
        case 'start':
          session.streamSid = data.start.streamSid;
          session.twilioReady = true;
          console.log(`📡 Twilio stream startet: ${session.streamSid}`);
          resetInactivityTimer();
          if (session.openAiReady && !session.greeted) setTimeout(sendGreeting, 400);
          break;

        case 'media':
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload })
            );
          }
          resetInactivityTimer();
          break;
      }
    } catch (err) {
      console.error('⚠️ Fejl i Twilio-besked:', err);
    }
  });

  conn.on('close', async () => {
    cleanup(session, openAiWs);
    console.log(`🔴 Forbindelse lukket: ${session.id}`);
    await processTranscriptAndSend(session.transcript, session.id);
    sessions.delete(session.id);
  });

  openAiWs.on('close', () => console.log('🧹 OpenAI socket lukket'));
  openAiWs.on('error', (err) => console.error('❌ OpenAI WebSocket fejl:', err));
}

// ===== CLEANUP =====
function cleanup(session, openAiWs) {
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
  if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
}

// ===== END CALL =====
function gracefulHangup(conn, session, reason) {
  console.log(`📞 Afslutter opkald pga. ${reason}`);
  const farewell = {
    type: 'response.create',
    response: {
      instructions:
        'Sig venligt: "Det ser ud til, at forbindelsen er blevet stille. Jeg afslutter samtalen nu. Ha’ en god dag!"',
      modalities: ['audio'],
      voice: VOICE,
    },
  };
  conn.send(JSON.stringify(farewell));
  setTimeout(() => endCall(conn, session, reason), 3500);
}

function endCall(conn, session, reason = 'Ukendt') {
  console.log(`☎️ Hangup (${reason}) for session ${session.id}`);
  try {
    const hangup = { event: 'stop' };
    conn.send(JSON.stringify(hangup));
  } catch (err) {
    console.error('⚠️ Fejl ved hangup:', err);
  }
}

// ===== POST-CALL PROCESSING =====
async function makeChatGPTCompletion(transcript) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [
          { role: 'system', content: 'Extract customer details: name, availability, and notes.' },
          { role: 'user', content: transcript },
        ],
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('❌ makeChatGPTCompletion fejl:', err);
  }
}

async function sendToWebhook(payload) {
  if (!WEBHOOK_URL) return console.warn('⚠️ Ingen webhook sat.');
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(res.ok ? '✅ Webhook sendt' : '❌ Webhook fejl');
  } catch (err) {
    console.error('❌ Webhook fejl:', err);
  }
}

async function processTranscriptAndSend(transcript, id) {
  console.log(`📝 Behandler transkript for ${id}`);
  try {
    const result = await makeChatGPTCompletion(transcript);
    const content = result?.choices?.[0]?.message?.content;

    if (!content) {
      console.warn('⚠️ Ingen content modtaget fra OpenAI');
      return;
    }

    try {
      const parsed = JSON.parse(content);
      await sendToWebhook(parsed);
    } catch {
      console.warn('⚠️ Modtaget ikke-JSON svar fra OpenAI:', content);
    }
  } catch (err) {
    console.error('❌ processTranscriptAndSend fejl:', err);
  }
}

// ===== START SERVER =====
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server kører på port ${PORT}`);
});
