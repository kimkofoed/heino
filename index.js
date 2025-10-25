import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { OPENAI_API_KEY, WEBHOOK_URL, SYSTEM_MESSAGE } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file or in Render environment settings.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Session management
const sessions = new Map();

// Event types to log
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

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all('/voice', async (request, reply) => {
    console.log('Incoming call detected');

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Say language="da-DK">Dirty Ranch Steakhouse du taler med Ava. Hvad kan jeg hjælpe dig med?</Say>
            <Connect>
                <Stream url="wss://${request.headers.host}/media-stream" />
            </Connect>
        </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected to /media-stream');

        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || { transcript: '', streamSid: null };
        sessions.set(sessionId, session);

        const openAiWs = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'OpenAI-Beta': 'realtime=v1',
                },
            }
        );

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ['text', 'audio'],
                    temperature: 0.8,
                    input_audio_transcription: { model: 'whisper-1' },
                },
            };

            console.log('🛰️ Sending session update to OpenAI');
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
                    console.log(`Event: ${response.type}`);
                }

                // Handle user speech transcription
                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`User (${sessionId}): ${userMessage}`);
                }

                // Handle AI responses
                if (response.type === 'response.done') {
                    const agentMessage =
                        response.response.output[0]?.content?.find(
                            (content) => content.transcript
                        )?.transcript || 'Agent message not found';
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                // Handle audio output
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: session.streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') },
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
                            openAiWs.send(
                                JSON.stringify({
                                    type: 'input_audio_buffer.append',
                                    audio: data.media.payload,
                                })
                            );
                        }
                        break;
                    case 'start':
                        session.streamSid = data.start.streamSid;
                        console.log('Incoming stream started', session.streamSid);
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

// IMPORTANT: Bind to 0.0.0.0 for Render
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`🚀 Server is listening on port ${PORT}`);
});

// ====== Helper Functions ======

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
        console.log('ChatGPT API response received.');
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

        if (response.ok) {
            console.log('Data successfully sent to webhook.');
        } else {
            console.error('Webhook failed:', response.statusText);
        }
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
