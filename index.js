import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';
import twilio from 'twilio';

const { VoiceResponse } = twilio.twiml;

dotenv.config();
const { OPENAI_API_KEY, WEBHOOK_URL } = process.env;

if (!OPENAI_API_KEY) {
    console.error('❌ Missing OpenAI API key. Please set it in .env file.');
    process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE =
    'Du er en AI-receptionist for Dirty Ranch Steakhouse, en hyggelig og stemningsfuld steakrestaurant. Din rolle er at tage imod gæster på en venlig, høflig og naturlig måde, og hjælpe dem med reservationer eller forespørgsler. Du taler, skriver og forstår dansk grammatik, stavning og udtale korrekt. Du forstår danske vokaler og navne præcist — fx at "Kim" er et dansk fornavn og ikke et ord, der skal oversættes eller ændres. Du skal respektere store og små bogstaver, samt brugen af æ, ø og å i danske navne og ord. Du må aldrig gætte eller ændre et navn – skriv det præcis, som gæsten oplyser det. Din samtalestil skal være venlig, rolig og professionel – som en imødekommende receptionist. Brug naturlig dansk sætningsopbygning og en varm tone. Stil kun ét spørgsmål ad gangen. Brug korte, personlige svar – undgå at lyde som en formular. Små venlige bemærkninger er velkomne, f.eks. “Hvor dejligt!”, “Selvfølgelig, jeg hjælper dig med det.” eller “Tak, det noterer jeg.” Din opgave er at føre en samtale for at indsamle følgende oplysninger: 1) Gæstens navn. 2) Dato og tidspunkt for besøget. 3) Antal personer. 4) Eventuelle særlige ønsker (f.eks. allergier, fødselsdag, bordønsker). Du må ikke bede om telefonnummer, e-mail eller anden kontaktinformation. Du skal ikke tjekke ledighed – antag, at der altid er plads.';

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
    'conversation.item.input_audio_transcription.completed'
];

// ✅ Root route
fastify.get('/', async (_, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// ✅ Health-check route
fastify.get('/health', async (_, reply) => {
    reply.code(200).send({ status: 'ok' });
});

// ✅ Twilio incoming call handler
fastify.all('/voice', async (request, reply) => {
    console.log('📞 Incoming call');

    const response = new VoiceResponse();
    response.say('Hej, du har ringet til Dirty Ranch. Hvad kan jeg hjælpe dig med?', {
        voice: 'Polly.Naja',
        language: 'da-DK'
    });

    response.pause({ length: 1 });
    const connect = response.connect();
    connect.stream({ url: `wss://${request.headers.host}/media-stream` });

    reply.type('text/xml').send(response.toString());
});

// ✅ WebSocket route
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        console.log(`🎧 New call session: ${sessionId}`);

        let session = { transcript: '', streamSid: null, createdAt: Date.now() };
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

        // 🟢 Heartbeat & timeout
        let pingTimeout;
        function heartbeat() {
            clearTimeout(pingTimeout);
            pingTimeout = setTimeout(() => {
                console.warn('⚠️ OpenAI WS timeout, closing...');
                openAiWs.terminate();
            }, 10000);
        }

        // 🧠 Latency tracking
        let firstAudioTimestamp = null;

        openAiWs.on('open', () => {
            console.log('✅ Connected to OpenAI Realtime API');
            heartbeat();

            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: { model: "whisper-1" }
                }
            };

            setTimeout(() => {
                openAiWs.send(JSON.stringify(sessionUpdate));
                console.log('📤 Sent session update');
            }, 250);
        });

        openAiWs.on('ping', heartbeat);
        openAiWs.on('pong', heartbeat);

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`📨 Event: ${response.type}`);
                }

                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`👤 User: ${userMessage}`);
                }

                if (response.type === 'response.done') {
                    const agentMessage = response.response.output[0]?.content?.find(c => c.transcript)?.transcript || 'Agent message not found';
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`🤖 Agent: ${agentMessage}`);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    if (!firstAudioTimestamp) {
                        firstAudioTimestamp = Date.now();
                        console.log(`⚡ Latency: ${firstAudioTimestamp - session.createdAt} ms`);
                    }

                    const audioDelta = {
                        event: 'media',
                        streamSid: session.streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('❌ Error processing OpenAI message:', error);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            setImmediate(() => {
                                openAiWs.send(JSON.stringify({
                                    type: 'input_audio_buffer.append',
                                    audio: data.media.payload
                                }));
                            });
                        }
                        break;
                    case 'start':
                        session.streamSid = data.start.streamSid;
                        console.log(`🎙️ Stream started: ${session.streamSid}`);
                        break;
                    default:
                        break;
                }
            } catch (error) {
                console.error('❌ Error parsing Twilio message:', error);
            }
        });

        connection.on('close', async () => {
            console.log(`🔚 Call ended (${sessionId})`);
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, 'normal close');
            clearTimeout(pingTimeout);
            await processTranscriptAndSend(session.transcript, sessionId);
            sessions.delete(sessionId);
        });

        openAiWs.on('close', () => console.log('🧹 OpenAI WS closed cleanly'));
        openAiWs.on('error', (error) => console.error('💥 OpenAI WS error:', error.message));
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`🚀 Server listening on port ${PORT}`);
});

// 🧠 === Processing + Webhook Logic (ikke fjernet) ===
async function makeChatGPTCompletion(transcript) {
    console.log('Starting ChatGPT API call...');
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "gpt-4o-2024-08-06",
                messages: [
                    { role: "system", content: "Extract customer details: name, availability, and any special notes from the transcript." },
                    { role: "user", content: transcript }
                ],
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "customer_details_extraction",
                        schema: {
                            type: "object",
                            properties: {
                                customerName: { type: "string" },
                                customerAvailability: { type: "string" },
                                specialNotes: { type: "string" }
                            },
                            required: ["customerName", "customerAvailability", "specialNotes"]
                        }
                    }
                }
            })
        });

        const data = await response.json();
        console.log('ChatGPT API response:', JSON.stringify(data, null, 2));
        return data;
    } catch (error) {
        console.error('Error making ChatGPT completion call:', error);
        throw error;
    }
}

async function sendToWebhook(payload) {
    console.log('Sending data to webhook:', JSON.stringify(payload, null, 2));
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('Webhook response status:', response.status);
        if (response.ok) console.log('✅ Data sent to webhook.');
        else console.error('❌ Failed to send data to webhook:', response.statusText);
    } catch (error) {
        console.error('Error sending data to webhook:', error);
    }
}

async function processTranscriptAndSend(transcript, sessionId = null) {
    console.log(`Processing transcript for session ${sessionId}...`);
    try {
        const result = await makeChatGPTCompletion(transcript);
        if (result.choices && result.choices[0]?.message?.content) {
            const parsedContent = JSON.parse(result.choices[0].message.content);
            await sendToWebhook(parsedContent);
            console.log('✅ Extracted and sent customer details:', parsedContent);
        } else {
            console.error('Unexpected response structure from ChatGPT API');
        }
    } catch (error) {
        console.error('Error in processTranscriptAndSend:', error);
    }
}

// 🧩 Session health monitor
setInterval(() => console.log(`🧠 Active sessions: ${sessions.size}`), 10000);

// 🧩 Global error handlers
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
