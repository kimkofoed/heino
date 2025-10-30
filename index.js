import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import twilio from 'twilio';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

const { VoiceResponse } = twilio.twiml;

dotenv.config();

const { OPENAI_API_KEY, WEBHOOK_URL, ASSISTANT_ID } = process.env;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}
if (!ASSISTANT_ID) {
  console.error('❌ Missing ASSISTANT_ID (should be your wf_... ID)');
  process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const sessions = new Map();

const LOG_EVENT_TYPES = [
  'response.content.done',
  'response.done',
  'input_audio_buffer.speech_stopped',
  'conversation.item.input_audio_transcription.completed',
  'response.function_call'
];

// ✅ Root + Health routes
fastify.get('/', async (_, reply) => reply.send({ message: '✅ Twilio Media Stream Server is running!' }));
fastify.get('/health', async (_, reply) => reply.code(200).send({ status: 'ok' }));

// ✅ Twilio call entrypoint
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

// ✅ WebSocket: Twilio ↔ OpenAI
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
    console.log(`🎧 New call session: ${sessionId}`);

    const session = { transcript: '', streamSid: null, createdAt: Date.now() };
    sessions.set(sessionId, session);

    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    // 🟢 Heartbeat
    let pingTimeout;
    function heartbeat() {
      clearTimeout(pingTimeout);
      pingTimeout = setTimeout(() => {
        console.warn('⚠️ OpenAI WS timeout, closing...');
        openAiWs.terminate();
      }, 10000);
    }

    // 🧠 Session setup with bridge tool
    openAiWs.on('open', () => {
      console.log('✅ Connected to OpenAI Realtime API');
      heartbeat();

        const sessionUpdate = {
        type: 'session.update',
        session: {
            assistant_id: ASSISTANT_ID,
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            modalities: ['audio', 'text'],
            input_audio_transcription: { model: 'whisper-1' },
            instructions: `
            Du er en dansk telefonassistent for Dirty Ranch Steakhouse.
            Hver gang brugeren siger noget, skal du KALDE funktionen call_restaurant_workflow 
            med hele den transskriberede tekst som user_text.
            Brug svaret fra workflowet som dit svar til brugeren.
            Svar altid naturligt og venligt på dansk.
            `,
            tools: [
            {
                name: 'call_restaurant_workflow',
                description: 'Sender tekst til restaurantens workflow og returnerer svaret.',
                parameters: {
                type: 'object',
                properties: {
                    user_text: { type: 'string', description: 'Hvad brugeren sagde' }
                },
                required: ['user_text']
                }
            }
            ],
            // (valgfrit men hjælpsomt)
            tool_choice: {
            type: "function",
            function: { name: "call_restaurant_workflow" }
            }
        }
    };


      openAiWs.send(JSON.stringify(sessionUpdate));
      console.log('🧠 Sent session update with assistant_id + bridge tool');
    });

    openAiWs.on('ping', heartbeat);
    openAiWs.on('pong', heartbeat);

    // 🔄 Handle OpenAI messages
    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`📨 Event: ${response.type}`);
        }

        // 🎙️ Handle speech events
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          console.log(`👤 User: ${userMessage}`);
        }

        // 🧩 Tool Call bridge to workflow
        if (response.type === 'response.function_call' && response.name === 'call_restaurant_workflow') {
          const userText = response.arguments?.user_text || '';
          console.log(`📡 Sending to workflow: ${userText}`);

          try {
            const wfResponse = await fetch(`https://api.openai.com/v1/workflows/${ASSISTANT_ID}/runs`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ input: { user_text: userText } })
            });

            const result = await wfResponse.json();
            const replyText =
              result.output?.text ||
              result.output_text ||
              'Beklager, der opstod en fejl i workflowet.';

            console.log(`🤖 Workflow replied: ${replyText}`);

            openAiWs.send(
              JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['audio', 'text'],
                  instructions: replyText
                }
              })
            );
          } catch (err) {
            console.error('❌ Workflow bridge error:', err);
          }
        }

        // 🗣️ Audio back to Twilio
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid: session.streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));
        }

        // 🧾 Agent response logging
        if (response.type === 'response.done') {
          const agentMessage =
            response.response.output?.[0]?.content?.find((c) => c.transcript)?.transcript || '';
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`🤖 Agent: ${agentMessage}`);
        }
      } catch (error) {
        console.error('❌ Error processing OpenAI message:', error);
      }
    });

    // 🎧 Handle incoming Twilio audio
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(
                JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload })
              );
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

    // 📴 Cleanup
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

// 🧠 Post-call transcript -> webhook
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
          { role: 'system', content: 'Extract customer details: name, availability, and notes.' },
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
    }
  } catch (error) {
    console.error('❌ Error in processTranscriptAndSend:', error);
  }
}
