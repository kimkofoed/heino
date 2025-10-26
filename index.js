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

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY, WEBHOOK_URL } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE =
    'Du er en AI-receptionist for Dirty Ranch Steakhouse, en hyggelig og stemningsfuld steakrestaurant. Din rolle er at tage imod gæster på en venlig, høflig og naturlig måde, og hjælpe dem med reservationer eller forespørgsler. Du taler, skriver og forstår dansk grammatik, stavning og udtale korrekt. Du forstår danske vokaler og navne præcist — fx at "Kim" er et dansk fornavn og ikke et ord, der skal oversættes eller ændres. Du skal respektere store og små bogstaver, samt brugen af æ, ø og å i danske navne og ord. Du må aldrig gætte eller ændre et navn – skriv det præcis, som gæsten oplyser det. Din samtalestil skal være venlig, rolig og professionel – som en imødekommende receptionist. Brug naturlig dansk sætningsopbygning og en varm tone. Stil kun ét spørgsmål ad gangen. Brug korte, personlige svar – undgå at lyde som en formular. Små venlige bemærkninger er velkomne, f.eks. “Hvor dejligt!”, “Selvfølgelig, jeg hjælper dig med det.” eller “Tak, det noterer jeg.” Din opgave er at føre en samtale for at indsamle følgende oplysninger: 1) Gæstens navn. 2) Dato og tidspunkt for besøget. 3) Antal personer. 4) Eventuelle særlige ønsker (f.eks. allergier, fødselsdag, bordønsker). Du må ikke bede om telefonnummer, e-mail eller anden kontaktinformation. Du skal ikke tjekke ledighed – antag, at der altid er plads. Eksempel på samtaleforløb: AI: “Hej og velkommen til Dirty Ranch Steakhouse! Hvor er det dejligt, at du skriver til os. Må jeg starte med at få dit navn?” Gæst: “Jeg hedder Kim.” AI: “Tak, Kim! Hvornår kunne du tænke dig at komme forbi og spise hos os?” Gæst: “Fredag kl. 19.” AI: “Perfekt! Hvor mange personer skal jeg reservere bord til?” Gæst: “Fire.” AI: “Super, jeg har noteret et bord til fire personer på fredag kl. 19. Er der nogle særlige ønsker, jeg skal skrive på reservationen?”';

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Session management
const sessions = new Map();

// Event types for debugging
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

// Root route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// ✅ UPDATED: Twilio incoming call handler
fastify.all('/voice', async (request, reply) => {
    console.log('Incoming call');

    const response = new VoiceResponse();

    // Dansk velkomstbesked
    response.say(
        'Hej, du har ringet til Dirty Ranch Steakhouse. Et øjeblik, mens jeg forbinder dig til vores AI-receptionist.',
        {
            voice: 'Google.da-DK-Wavenet-A',
            language: 'da-DK'
        }
    );

    // Pause for naturlig tale
    response.pause({ length: 1 });

    // Introduktion
    response.say('Okay, du kan begynde at tale nu.', {
        voice: 'Google.da-DK-Wavenet-A',
        language: 'da-DK'
    });

    // Tilføj stream-forbindelsen til real-time AI
    const connect = response.connect();
    connect.stream({ url: `wss://${request.headers.host}/media-stream` });

    // Send TwiML som XML til Twilio
    reply.type('text/xml').send(response.toString());
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || { transcript: '', streamSid: null };
        sessions.set(sessionId, session);

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            }
        });

        const sendSessionUpdate = () => {
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
                    input_audio_transcription: {
                        model: "whisper-1"
                    }
                }
            };
            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`User (${sessionId}): ${userMessage}`);
                }

                if (response.type === 'response.done') {
                    const agentMessage = response.response.output[0]?.content?.find(content => content.transcript)?.transcript || 'Agent message not found';
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: session.streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        session.streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', session.streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log(`Client disconnected (${sessionId}).`);
            console.log('Full Transcript:');
            console.log(session.transcript);

            await processTranscriptAndSend(session.transcript, sessionId);
            sessions.delete(sessionId);
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});

// Function to make ChatGPT API completion call
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

        console.log('ChatGPT API response status:', response.status);
        const data = await response.json();
        console.log('Full ChatGPT API response:', JSON.stringify(data, null, 2));
        return data;
    } catch (error) {
        console.error('Error making ChatGPT completion call:', error);
        throw error;
    }
}

// Function to send data to webhook
async function sendToWebhook(payload) {
    console.log('Sending data to webhook:', JSON.stringify(payload, null, 2));
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        console.log('Webhook response status:', response.status);
        if (response.ok) {
            console.log('Data successfully sent to webhook.');
        } else {
            console.error('Failed to send data to webhook:', response.statusText);
        }
    } catch (error) {
        console.error('Error sending data to webhook:', error);
    }
}

// Function to process and send extracted details
async function processTranscriptAndSend(transcript, sessionId = null) {
    console.log(`Starting transcript processing for session ${sessionId}...`);
    try {
        const result = await makeChatGPTCompletion(transcript);

        if (result.choices && result.choices[0]?.message?.content) {
            const parsedContent = JSON.parse(result.choices[0].message.content);
            await sendToWebhook(parsedContent);
            console.log('Extracted and sent customer details:', parsedContent);
        } else {
            console.error('Unexpected response structure from ChatGPT API');
        }
    } catch (error) {
        console.error('Error in processTranscriptAndSend:', error);
    }
}
