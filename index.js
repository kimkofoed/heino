import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
import twilio from 'twilio';

// Twilio VoiceResponse
const { VoiceResponse } = twilio.twiml;

// Load environment variables
dotenv.config();

const { OPENAI_API_KEY, WEBHOOK_URL, ASSISTANT_ID } = process.env;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

// ✅ Initialize Fastify instance before any routes
const fastify = Fastify({
  logger: true // optional but great for debugging on Render
});

// Register plugins
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// ----------------------
// ⚙️ BASIC CONFIG
// ----------------------
const builderConfig = {
  assistant_id: ASSISTANT_ID
};

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Session management
const sessions = new Map();

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

// ----------------------
// 🌐 ROUTES
// ----------------------
fastify.get('/', async (_, reply) => {
  reply.send({ message: '✅ Twilio Media Stream Server is running!' });
});

fastify.get('/health', async (_, reply) => {
  reply.code(200).send({ status: 'ok' });
});

// ----------------------
// 📞 Twilio incoming call
// ----------------------
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

// ----------------------
// 🔊 WebSocket handling
// ----------------------
// WebSocket route
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('🔗 Client connected');

    const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || { transcript: '', streamSid: null };
    sessions.set(sessionId, session);

    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    // ✅ OpenAI Realtime Session Setup (no barge-in)
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          // 👇 OpenAI håndterer pauser, tale-stop og svar
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 700, // naturlig pause på 0,7 sek
            create_response: true
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          assistant_id: builderConfig.assistant_id,
          modalities: ["text", "audio"],
          temperature: 0.8,
          input_audio_transcription: { model: "whisper-1" }
        }
      };
      console.log('🧠 Sending session update with Assistant:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on('open', () => {
    console.log('✅ Connected to OpenAI Realtime API');
    // ⛔ Fjernet setTimeout — vi venter på session.created i stedet
    });

    openAiWs.on('message', (data) => {
    try {
        const response = JSON.parse(data);

        // 🟢 Når session er klar → send opdatering
        if (response.type === 'session.created') {
        console.log('✅ Session created — sending update with g711_ulaw');
        sendSessionUpdate();
        }

        if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`📨 Received event: ${response.type}`, response);
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

        // 🎧 Send lyd tilbage til Twilio
        if (response.type === 'response.audio.delta' && response.delta) {
        const audioDelta = {
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: response.delta } // allerede base64-encoded
        };
        connection.send(JSON.stringify(audioDelta));
        }

        if (response.type === 'session.updated') {
        console.log('✅ Session updated successfully:', response);
        }
    } catch (error) {
        console.error('❌ Error processing OpenAI message:', error, 'Raw:', data);
    }
    });

    // 🎙️ Twilio sender lyd → OpenAI input buffer
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
            console.log('🎧 Stream started:', session.streamSid);
            break;

          default:
            console.log('ℹ️ Non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('❌ Error parsing Twilio message:', error);
      }
    });

    connection.on('close', async () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log(`🔌 Client disconnected (${sessionId}).`);
      console.log('📝 Full Transcript:\n', session.transcript);

      await processTranscriptAndSend(session.transcript, sessionId);
      sessions.delete(sessionId);
    });

    openAiWs.on('close', () => console.log('❎ Disconnected from OpenAI Realtime API'));
    openAiWs.on('error', (error) => console.error('💥 Error in OpenAI WebSocket:', error));
  });
});


// ----------------------
// 🚀 START SERVER
// ----------------------
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Server is running at ${address}`);
});

// ----------------------
// 🔧 UTILITY FUNCTIONS
// ----------------------
async function makeChatGPTCompletion(transcript) {
  console.log('🧩 Starting ChatGPT API call...');
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
          { role: 'system', content: 'Extract customer details: name, availability, and any special notes from the transcript.' },
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
