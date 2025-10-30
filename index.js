import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import twilio from 'twilio';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Twilio VoiceResponse
const { VoiceResponse } = twilio.twiml;

// Load environment variables
dotenv.config();

// Env variables
const { OPENAI_API_KEY, WEBHOOK_URL, ASSISTANT_ID } = process.env;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

if (!ASSISTANT_ID) {
  console.error('❌ Missing ASSISTANT_ID. Please set it in the .env file.');
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Session management
const sessions = new Map();

// Loggable event types
const LOG_EVENT_TYPES = [
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'response.text.done',
  'conversation.item.input_audio_transcription.completed'
];

// ✅ Root route
fastify.get('/', async (_, reply) => {
  reply.send({ message: '✅ Twilio Media Stream Server is running!' });
});

// ✅ Health-check route
fastify.get('/health', async (_, reply) => {
  reply.code(200).send({ status: 'ok' });
});

// ✅ Twilio incoming call handler
fastify.all('/voice', async (request, reply) => {
  console.log('📞 Incoming call');

  const response = new VoiceResponse();
  response.say('Hej, du har ringet til Dirty Ranch Steakhouse. Hvad kan jeg hjælpe dig med?', {
    voice: 'Polly.Naja',
    language: 'da-DK'
  });

  response.pause({ length: 1 });

  const connect = response.connect();
  connect.stream({ url: `wss://${request.headers.host}/media-stream` });

  reply.type('text/xml').send(response.toString());
});

// ✅ WebSocket: Twilio <-> OpenAI
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
    console.log(`🎧 New call session: ${sessionId}`);

    let session = { transcript: '', streamSid: null, createdAt: Date.now() };
    sessions.set(sessionId, session);

    // OpenAI Realtime WS
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    // 🟢 Keepalive
    let pingTimeout;
    function heartbeat() {
      clearTimeout(pingTimeout);
      pingTimeout = setTimeout(() => {
        console.warn('⚠️ OpenAI WS timeout, closing...');
        openAiWs.terminate();
      }, 10000);
    }

    openAiWs.on('open', () => {
      console.log('✅ Connected to OpenAI Realtime API');
      heartbeat();

      // Send session.update → use assistant_id instead of SYSTEM_MESSAGE
      const sessionUpdate = {
        type: 'session.update',
        session: {
          assistant_id: ASSISTANT_ID, // 👈 key integration
          input_audio_format: 'g711_ulaw',   // 👈 Twilio inbound
          output_audio_format: 'g711_ulaw',  // 👈 Twilio outbound
          voice: VOICE,
          input_audio_transcription: { model: 'whisper-1' }
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
      console.log('🧠 Sent session update with assistant_id');
    });

    openAiWs.on('ping', heartbeat);
    openAiWs.on('pong', heartbeat);

    // 🔄 Handle OpenAI events
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`📨 Event: ${response.type}`, response);
        }

        if (response.type === 'input_audio_buffer.speech_started') {
          session.speechStartTime = Date.now();
          console.log(`🎤 User started speaking`);
        }

        if (response.type === 'input_audio_buffer.speech_stopped') {
          console.log('🗣️ Speech stopped – requesting AI response');
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }

        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          console.log(`👤 User (${sessionId}): ${userMessage}`);
        }

        if (response.type === 'response.done') {
          const agentMessage =
            response.response.output[0]?.content?.find(c => c.transcript)?.transcript ||
            'Agent message not found';
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`🤖 Agent (${sessionId}): ${agentMessage}`);
        }

        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));
        }

        if (response.type === 'session.updated') {
          console.log('✅ Session updated successfully:', response);
        }
      } catch (error) {
        console.error('❌ Error processing OpenAI message:', error, 'Raw message:', data);
      }
    });

    // 🎙️ Twilio → OpenAI audio
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              }));
            }
            break;
          case 'start':
            session.streamSid = data.start.streamSid;
            console.log(`🎙️ Stream started: ${session.streamSid}`);
            break;
          default:
            console.log('ℹ️ Non-media event:', data.event);
        }
      } catch (error) {
        console.error('❌ Error parsing Twilio message:', error);
      }
    });

    connection.on('close', async () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, 'normal close');
      clearTimeout(pingTimeout);
      console.log(`🔚 Client disconnected (${sessionId})`);
      console.log('📝 Full Transcript:\n', session.transcript);

      await processTranscriptAndSend(session.transcript, sessionId);
      sessions.delete(sessionId);
    });

    openAiWs.on('close', () => console.log('🧹 OpenAI WS closed cleanly'));
    openAiWs.on('error', (error) => console.error('💥 OpenAI WS error:', error.message));
  });
});

// 🚀 Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server listening on port ${PORT}`);
});

// ----------------------
// 🧠 Webhook processing
// ----------------------
async function makeChatGPTCompletion(transcript) {
  console.log('Starting ChatGPT API call...');
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [
          {
            role: 'system',
            content: 'Extract customer details: name, availability, and any special notes from the transcript.'
          },
          { role: 'user', content: transcript }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'customer_details_extraction',
            schema: {
              type: 'object',
              properties: {
                customerName: { type: 'string' },
                customerAvailability: { type: 'string' },
                specialNotes: { type: 'string' }
              },
              required: ['customerName', 'customerAvailability', 'specialNotes']
            }
          }
        }
      })
    });

    const data = await response.json();
    console.log('✅ ChatGPT API response:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('❌ Error making ChatGPT completion call:', error);
    throw error;
  }
}

async function sendToWebhook(payload) {
  console.log('📤 Sending data to webhook:', JSON.stringify(payload, null, 2));
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('Webhook response status:', response.status);
    if (response.ok) console.log('✅ Data successfully sent to webhook.');
    else console.error('⚠️ Failed to send data to webhook:', response.statusText);
  } catch (error) {
    console.error('❌ Error sending data to webhook:', error);
  }
}

async function processTranscriptAndSend(transcript, sessionId = null) {
  console.log(`🧠 Processing transcript for session ${sessionId}...`);
  try {
    const result = await makeChatGPTCompletion(transcript);
    if (result.choices && result.choices[0]?.message?.content) {
      const parsedContent = JSON.parse(result.choices[0].message.content);
      await sendToWebhook(parsedContent);
      console.log('✅ Extracted and sent customer details:', parsedContent);
    } else {
      console.error('⚠️ Unexpected response structure from ChatGPT API');
    }
  } catch (error) {
    console.error('❌ Error in processTranscriptAndSend:', error);
  }
}
