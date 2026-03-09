import { config } from "dotenv";
import { inspect } from "node:util";
import { Agent, getTestUrl } from "@xmtp/agent-sdk";
import {
  createPaymentWrapper,
  x402ResourceServer,
  x402Codecs
} from "@x402/xmtp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("❌ EVM_ADDRESS environment variable is required");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

type PreviewMessage = {
  contentType?: { authorityId: string; typeId: string };
  content: unknown;
};

function getDisplayedContentType(message: PreviewMessage): string {
  const outer = message.contentType
    ? `${message.contentType.authorityId}/${message.contentType.typeId}`
    : "unknown";

  if (
    message.contentType?.authorityId !== "xmtp.org" ||
    message.contentType?.typeId !== "reply" ||
    !message.content ||
    typeof message.content !== "object"
  ) {
    return outer;
  }

  const innerContentType = (message.content as { contentType?: { authorityId?: string; typeId?: string } })
    .contentType;

  if (!innerContentType?.authorityId || !innerContentType?.typeId) {
    return outer;
  }

  return `${outer} -> ${innerContentType.authorityId}/${innerContentType.typeId}`;
}

function logIncoming(message: PreviewMessage): void {
  const typeStr = getDisplayedContentType(message);
  const content = message.content;
  const preview =
    typeof content === "string"
      ? content.slice(0, 80)
      : inspect(content, { depth: 3, breakLength: Infinity }).slice(0, 80);

  console.log(`[server] Incoming: ${typeStr} | ${preview}${preview.length >= 80 ? "…" : ""}`);
}

async function main(): Promise<void> {
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register("eip155:84532", new ExactEvmScheme());
  await resourceServer.initialize();

  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: evmAddress,
    price: "$0.001",
  });

  const { middleware, requestPayment } = createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      description: "Weather data",
      mimeType: "application/json",
    },
    handler: async (originalMessage) => {
      const report = {
        weather: "sunny",
        temperature: 70,
      };
      return { text: JSON.stringify({ report }) };
    },
  });

  const agent = await Agent.createFromEnv({
    codecs: x402Codecs,
  });

  agent.on("reply", async (ctx) => {
    logIncoming(ctx.message);
    await middleware(ctx as unknown as Parameters<typeof middleware>[0], async () => {});
  });

  agent.on("text", async (ctx) => {
    logIncoming(ctx.message);
    const content = typeof ctx.message.content === "string" ? ctx.message.content : "";
    const cmd = content.trim().toLowerCase();
    if (cmd === "/help") {
      await ctx.conversation.sendText(
        "Free commands: /help\nPaid: send /weather to get weather data ($0.001)",
      );
      return;
    }
    if (cmd === "/weather" || cmd === "weather") {
      console.log("[server] Sending payment-required...");
      try {
        await requestPayment(ctx as unknown as Parameters<typeof requestPayment>[0]);
        console.log("[server] payment-required sent");
      } catch (err) {
        console.error("[server] requestPayment failed:", err);
        throw err;
      }
      return;
    }
    await ctx.conversation.sendText(
      "Send /weather for paid weather data, or /help for commands.",
    );
  });

  agent.on("start", () => {
    console.log(`Weather agent listening at ${agent.address}`);
    console.log(`🔗 ${getTestUrl(agent.client)}`);
  });

  await agent.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
