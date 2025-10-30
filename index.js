import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { z } from "zod";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";

dotenv.config();

const { OPENAI_API_KEY, WORKFLOW_ID } = process.env;
const PORT = process.env.PORT || 5050;

if (!OPENAI_API_KEY) throw new Error("❌ Missing OPENAI_API_KEY");
if (!WORKFLOW_ID) throw new Error("❌ Missing WORKFLOW_ID (wf_...)");

// 🚨 Log startup
console.log("🚀 Starting Twilio ↔ OpenAI Realtime bridge");
console.log("🔑 Using workflow:", WORKFLOW_ID);
console.log("🌐 Port:", PORT);

// 🧩 Tool: Bridge to your Workflow
const callRestaurantWorkflow = tool({
  name: "call_restaurant_workflow",
  description: "Calls the restaurant workflow and returns its reply text.",
  parameters: z.object({
    user_text: z.string().describe("The user's spoken input"),
  }),
  async execute({ user_text }) {
    console.log("🧩 TOOL: call_restaurant_workflow called with:", user_text);

    try {
      const response = await fetch(
        `https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ input: { user_text } }),
        }
      );

      console.log("🌐 Workflow request sent...");
      const json = await response.json();
      console.log("✅ Workflow raw response:", JSON.stringify(json, null, 2));

      const reply =
        json.output?.text ||
        json.output_text ||
        json.output?.message ||
        json.output?.content ||
        "Beklager, der opstod en fejl i workflowet.";

      console.log("🤖 Workflow reply extracted:", reply);
      return reply;
    } catch (err) {
      console.error("❌ Workflow request failed:", err);
      return "Der opstod en fejl ved kontakt til workflowet.";
    }
  },
});

// 🎙️ Agent definition
const agent = new RealtimeAgent({
  name: "Dirty Ranch Voice Agent",
  instructions: `
    Du er en dansk telefonassistent for Dirty Ranch Steakhouse.
    Hver gang brugeren siger noget, skal du kalde call_restaurant_workflow
    med hele transskriptionen som user_text.
    Brug svaret fra workflowet som dit svar til brugeren.
    Tal altid naturligt og venligt på dansk.
  `,
  tools: [callRestaurantWorkflow],
});

// 🛑 Guardrails
const guardrails = [
  {
    name: "Blocklist",
    async execute({ agentOutput }) {
      const banned = ["discount", "refund", "racist"];
      const found = banned.find((term) => agentOutput.includes(term));
      if (found) console.warn(`🚨 Blocked term detected: ${found}`);
      return { tripwireTriggered: !!found };
    },
  },
];

// ⚡ Server setup
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get("/", async (_, reply) =>
  reply.send({ message: "✅ Twilio + OpenAI Realtime SDK running" })
);
fastify.get("/health", async (_, reply) =>
  reply.code(200).send({ status: "ok" })
);

// 📞 Incoming Twilio call
fastify.all("/voice", async (request, reply) => {
  console.log("📞 Incoming call from Twilio");
  const twiml = `
<Response>
  <Say voice="Polly.Naja" language="da-DK">
    Hej, du har ringet til Dirty Ranch Steakhouse. Hvordan kan jeg hjælpe dig i dag?
  </Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`.trim();
  reply.type("text/xml").send(twiml);
});

// 🔄 Twilio Media Stream <-> OpenAI SDK
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, async (connection) => {
    console.log("🎧 New media stream connection from Twilio");

    try {
      const transport = new TwilioRealtimeTransportLayer({
        twilioWebSocket: connection,
      });

      console.log("🔄 Created Twilio transport layer");

      const session = new RealtimeSession(agent, {
        transport,
        outputGuardrails: guardrails,
      });

      session.on("stateChanged", (state) =>
        console.log("📡 Session state changed:", state)
      );

      session.on("message", (msg) =>
        console.log("📥 Raw message from Realtime API:", JSON.stringify(msg))
      );

      await session.connect({ apiKey: OPENAI_API_KEY });
      console.log("✅ Connected to OpenAI Realtime API (via SDK)");

      connection.on("close", () => {
        console.log("🔚 Twilio WebSocket closed");
      });
    } catch (err) {
      console.error("💥 Error initializing session:", err);
      connection.close();
    }
  });
});

// 🚀 Start the server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
  console.log(`🚀 Server live on port ${PORT}`);
});
