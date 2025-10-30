import Fastify from "fastify";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";
import { z } from "zod";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";

dotenv.config();
const { VoiceResponse } = twilio.twiml;

const { OPENAI_API_KEY, ASSISTANT_ID } = process.env;
if (!OPENAI_API_KEY) throw new Error("❌ Missing OPENAI_API_KEY");
if (!ASSISTANT_ID) throw new Error("❌ Missing ASSISTANT_ID");

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;
const VOICE = "alloy";

// 🧩 Tool: call workflow
const callRestaurantWorkflow = tool({
  name: "call_restaurant_workflow",
  description: "Sender tekst til restaurantens workflow og returnerer svaret.",
  parameters: z.object({
    user_text: z.string().describe("Det, brugeren sagde på dansk"),
  }),
  async execute({ user_text }) {
    console.log(`📡 Sender tekst til workflow: ${user_text}`);
    const res = await fetch(`https://api.openai.com/v1/workflows/${ASSISTANT_ID}/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: { user_text } }),
    });
    const json = await res.json();
    return (
      json.output?.text ||
      json.output_text ||
      json.output?.message ||
      "Beklager, der opstod en fejl i workflowet."
    );
  },
});

// 🧱 Guardrails: blokér bestemte ord i output
const guardrails = [
  {
    name: "Blocklist terms",
    async execute({ agentOutput }) {
      const blocked = ["rabatter", "refusion", "bandeord", "persondata"];
      const found = blocked.some((term) => agentOutput.toLowerCase().includes(term));
      if (found) console.log("🚫 Guardrail triggered — blocked term in output");
      return {
        tripwireTriggered: found,
        outputInfo: { blockedTerms: found },
      };
    },
  },
];

// 🧠 Agent config
const agent = new RealtimeAgent({
  name: "Dirty Ranch Telefonassistent",
  voice: VOICE,
  instructions: `
    Du er en dansk telefonassistent for Dirty Ranch Steakhouse.
    Hver gang brugeren siger noget, skal du kalde call_restaurant_workflow
    med hele den transskriberede tekst som user_text.
    Brug svaret fra workflowet som dit svar, og svar altid naturligt på dansk.
  `,
  tools: [callRestaurantWorkflow],
});

// ✅ Twilio webhook
fastify.all("/voice", async (req, reply) => {
  const response = new VoiceResponse();
  response.say("Hej, du har ringet til Dirty Ranch Steakhouse. Hvad kan jeg hjælpe dig med?", {
    voice: "Polly.Naja",
    language: "da-DK",
  });
  response.pause({ length: 1 });
  const connect = response.connect();
  connect.stream({ url: `wss://${req.headers.host}/media-stream` });
  reply.type("text/xml").send(response.toString());
});

// ✅ Media stream → SDK session
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, async (connection) => {
    try {
      const transport = new TwilioRealtimeTransportLayer({ twilioWebSocket: connection });
      const session = new RealtimeSession(agent, {
        transport,
        outputGuardrails: guardrails, // 🧱 her tilføjes guardrails
      });
      await session.connect({ apiKey: OPENAI_API_KEY });
      console.log("✅ Forbundet til OpenAI Realtime API (med guardrails)");
    } catch (err) {
      console.error("💥 Realtime-forbindelsesfejl:", err);
      connection.close();
    }
  });
});

// ✅ Health routes
fastify.get("/", async (_, r) => r.send({ ok: true }));
fastify.get("/health", async (_, r) => r.code(200).send({ status: "ok" }));

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) throw err;
  console.log(`🚀 Server kører på port ${PORT}`);
});
