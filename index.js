import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

const { OPENAI_API_KEY, WEBHOOK_URL, SYSTEM_MESSAGE } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key.');
  process.exit(1);
}

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
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'response.text.done',
  'conversation.item.input_audio_transcription.completed',
];

// Root route
fastify.get('/', async (req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// ====== TWILIO VOICE ROUTE ======
fastify.all('/voice', async (req, reply) => {
  console.log('Incoming call detected');

  // Lydløs <Say> + Connect Stream (Twilio kræver gyldig handling)
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say></Say>
  <Connect>
    <Stream
      url="wss://${req.headers.host}/media-stream"
      track="both_tracks"
      audioFormat="audio/opus;rate=16000"
    />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse.trim());
});

// ====== MEDIA STREAM ROUTE ======
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected to /media-stream');

    const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || { transcript: '', streamSid: null };
    sessions.set(sessionId, session);

    // Connect til OpenAI
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    // Send session.update når OpenAI socket åbner
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'opus_16000',
          output_audio_format: 'opus_16000',
          voice: VOICE,
          instructions:
            SYSTEM_MESSAGE ||
            'Du er en dansk stemmeassistent. Tal flydende, venligt og grammatisk korrekt dansk. Forvent danske navne og udtryk.',
          modalities: ['text', 'audio'],
          temperature: 0.8,
          input_audio_transcription: { model: 'whisper-1' },
        },
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      sendSessionUpdate();
    });

    // ====== OpenAI → Twilio ======
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Event: ${response.type}`);
        }

        // Brugers tale transskriberet
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          console.log(`User (${sessionId}): ${userMessage}`);
        }

        // AI svar
        if (response.type === 'response.done') {
          const agentMessage =
            response.response.output[0]?.content?.find((c) => c.transcript)?.transcript ||
            'Agent message not found';
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`Agent (${sessionId}): ${agentMessage}`);
        }

        // Lyd fra OpenAI sendes til Twilio
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid: session.streamSid,
            media: {
              payload: Buffer.from(response.delta, 'base64').toString('base64'),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error('Error processing OpenAI message:', error, 'Raw message:', data);
      }
    });

    // ====== Twilio → OpenAI ======
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            session.streamSid = data.start.streamSid;
            console.log('Incoming stream started:', session.streamSid);

            // 🔥 Nu hvor Twilio-stream er klar → lad OpenAI tale
            const greeting = {
              type: 'response.create',
              response: {
                instructions:
                  'Start samtalen på dansk med: "Hej, du taler med Ava fra Dirty Ranch Steakhouse. Hvordan kan jeg hjælpe dig i dag?"',
                modalities: ['audio'],
                voice: VOICE,
              },
            };
            openAiWs.send(JSON.stringify(greeting));
            break;

          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: data.media.payload,
                })
              );
            }
            break;

          default:
            console.log('Non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    connection.on('close', async () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log(`Client disconnected (${sessionId})`);
      console.log('Full Transcript:\n', session.transcript);
      await processTranscriptAndSend(session.transcript, sessionId);
      sessions.delete(sessionId);
    });

    openAiWs.on('close', () => console.log('Disconnected from OpenAI Realtime API'));
    openAiWs.on('error', (error) => console.error('OpenAI WebSocket Error:', error));
  });
});

// ====== START SERVER ======
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});

// ====== HELPER FUNKTIONER ======
async function makeChatGPTCompletion(transcript) {
  console.log('Starting ChatGPT API call...');
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
            content:
              'Extract customer details: name, availability, and any special notes from the transcript.',
          },
          { role: 'user', content: transcript },
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
                specialNotes: { type: 'string' },
              },
              required: ['customerName', 'customerAvailability', 'specialNotes'],
            },
          },
        },
      }),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error in makeChatGPTCompletion:', error);
    throw error;
  }
}

async function sendToWebhook(payload) {
  if (!WEBHOOK_URL) {
    console.warn('WEBHOOK_URL not defined. Skipping webhook call.');
    return;
  }

  console.log('Sending data to webhook:', JSON.stringify(payload, null, 2));
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) console.log('Data successfully sent to webhook.');
    else console.error('Webhook failed:', response.statusText);
  } catch (error) {
    console.error('Error sending data to webhook:', error);
  }
}

async function processTranscriptAndSend(transcript, sessionId = null) {
  console.log(`Processing transcript for session ${sessionId}...`);
  try {
    const result = await makeChatGPTCompletion(transcript);
    const content = result?.choices?.[0]?.message?.content;
    if (!content) {
      console.error('Unexpected response structure from ChatGPT');
      return;
    }
    const parsedContent = JSON.parse(content);
    console.log('Extracted details:', parsedContent);
    await sendToWebhook(parsedContent);
  } catch (error) {
    console.error('Error in processTranscriptAndSend:', error);
  }
}
