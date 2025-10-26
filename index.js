import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

// Load env
dotenv.config();
const { OPENAI_API_KEY, WEBHOOK_URL, SYSTEM_MESSAGE } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key.');
  process.exit(1);
}

// Init server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const sessions = new Map();

const LOG_EVENT_TYPES = [
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'conversation.item.input_audio_transcription.completed',
];

// --- Routes ---
fastify.get('/', async (_, reply) => {
  reply.send({ status: 'ok', message: 'Twilio + OpenAI voice server running 🚀' });
});

fastify.get('/health', async (_, reply) => {
  reply.send({ ok: true });
});

fastify.all('/voice', async (req, reply) => {
  console.log('📞 Incoming call detected');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say language="da-DK"></Say>
    <Connect>
      <Stream url="wss://${req.headers.host}/media-stream" />
    </Connect>
  </Response>`;
  reply.type('text/xml').send(twiml);
});

// --- WebSocket handler ---
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (conn, req) => {
    const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
    console.log(`🧩 Twilio connected: ${sessionId}`);

    const session = sessions.get(sessionId) || {
      transcript: '',
      streamSid: null,
      openAiReady: false,
      greeted: false,
    };
    sessions.set(sessionId, session);

    const ai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    // --- Functions ---
    const sendSessionUpdate = () => {
      const update = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions:
            SYSTEM_MESSAGE ||
            'Du er Ava, en dansk AI receptionist. Tal venligt og naturligt på dansk.',
          modalities: ['text', 'audio'],
          input_audio_transcription: { model: 'whisper-1' },
        },
      };
      ai.send(JSON.stringify(update));
      console.log('🟢 OpenAI session opdateret');
    };

    const sendGreeting = () => {
      if (session.greeted) return;
      session.greeted = true;
      console.log('🎙️ Sender dansk hilsen...');
      ai.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions:
              'Hej, du taler med Ava fra Dirty Ranch Steakhouse. Hvordan kan jeg hjælpe dig i dag?',
            modalities: ['audio'],
            voice: VOICE,
          },
        })
      );
    };

    // --- AI WebSocket ---
    ai.on('open', () => {
      console.log('✅ Forbundet til OpenAI Realtime API');
      setTimeout(() => {
        sendSessionUpdate();
        session.openAiReady = true;
        if (session.streamSid) setTimeout(sendGreeting, 500);
      }, 300);
    });

    ai.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(event.type)) console.log(`🔹 ${event.type}`);

        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          const msg = event.transcript.trim();
          session.transcript += `User: ${msg}\n`;
          console.log(`👤 Bruger: ${msg}`);
        }

        if (event.type === 'response.audio.delta' && event.delta) {
          console.log(`🎧 Modtog ${event.delta.length} bytes lyd fra OpenAI`);
          const audioDelta = {
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: event.delta }, // direkte base64-data
          };
          conn.send(JSON.stringify(audioDelta));
        }

        if (event.type === 'response.done') {
          const txt =
            event.response.output[0]?.content?.find((c) => c.transcript)?.transcript || '';
          if (txt) {
            session.transcript += `Ava: ${txt}\n`;
            console.log(`🤖 Ava: ${txt}`);
          }
        }
      } catch (err) {
        console.error('❌ Fejl i OpenAI message:', err);
      }
    });

    ai.on('close', () => console.log('🧹 OpenAI socket lukket'));
    ai.on('error', (err) => console.error('⚠️ OpenAI fejl:', err));

    // --- Twilio WebSocket ---
    conn.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        switch (data.event) {
          case 'start':
            session.streamSid = data.start.streamSid;
            console.log(`📡 Twilio stream startet: ${session.streamSid}`);
            if (session.openAiReady) setTimeout(sendGreeting, 500);
            break;
          case 'media':
            if (ai.readyState === WebSocket.OPEN)
              ai.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: data.media.payload,
                })
              );
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('⚠️ Fejl i Twilio data:', err);
      }
    });

    conn.on('close', async () => {
      console.log(`🔴 Forbindelse lukket: ${sessionId}`);
      if (ai.readyState === WebSocket.OPEN) ai.close();
      await processTranscriptAndSend(session.transcript, sessionId);
      sessions.delete(sessionId);
    });
  });
});

// --- Helper: extract & webhook ---
async function makeChatGPTCompletion(transcript) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-2024-08-06',
      messages: [
        {
          role: 'system',
          content: 'Extract customer details: name, availability, and notes.',
        },
        { role: 'user', content: transcript },
      ],
    }),
  });
  return res.json();
}

async function sendToWebhook(data) {
  if (!WEBHOOK_URL) return console.warn('⚠️ Ingen webhook defineret.');
  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function processTranscriptAndSend(transcript, id) {
  console.log(`📝 Behandler transkript for ${id}`);
  try {
    const result = await makeChatGPTCompletion(transcript);
    const content = result?.choices?.[0]?.message?.content;
    try {
      const parsed = JSON.parse(content);
      await sendToWebhook(parsed);
    } catch {
      console.warn('⚠️ Ikke-JSON svar fra OpenAI:', content);
    }
  } catch (err) {
    console.error('❌ processTranscriptAndSend fejl:', err);
  }
}

// --- Start server ---
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server kører på port ${PORT}`);
});
