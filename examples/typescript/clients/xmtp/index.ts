import { config } from "dotenv";
import { inspect } from "node:util";
import { Agent, getTestUrl, IdentifierKind } from "@xmtp/agent-sdk";
import { createPaymentClientMiddleware, x402Codecs, x402Client } from "@x402/xmtp";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const resourceAgentAddress = process.env.RESOURCE_AGENT_ADDRESS as `0x${string}`;

if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

if (!resourceAgentAddress) {
  console.error("❌ RESOURCE_AGENT_ADDRESS environment variable is required");
  console.error("   Use the server agent's address (printed when server starts)");
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

  console.log(`[client] Incoming: ${typeStr} | ${preview}${preview.length >= 80 ? "…" : ""}`);
}

async function main(): Promise<void> {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  const evmSigner = toClientEvmSigner(
    evmAccount,
    createPublicClient({ chain: baseSepolia, transport: http() }),
  );

  const agent = await Agent.createFromEnv({
    codecs: x402Codecs,
  });

  const paymentClient = new x402Client();
  paymentClient.register("eip155:84532", new ExactEvmScheme(evmSigner));

  const { middleware } = createPaymentClientMiddleware(paymentClient, {
    autoPayment: true,
    onPaymentRequested: async ({ paymentRequired }) => {
      const first = paymentRequired.accepts[0];
      console.log(`\nPayment requested: ${first?.amount} on ${first?.network}`);
      return true;
    },
    onAfterPayment: async ({ settlement }) => {
      console.log(`\nSettlement: ${settlement.success ? "success" : "failed"}`);
    },
  });

  agent.on("reply", async (ctx) => {
    logIncoming(ctx.message);
    await middleware(ctx as unknown as Parameters<typeof middleware>[0], async () => {});
  });

  const responsePromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          "Timeout: No response received. Ensure the server is running (pnpm dev in examples/typescript/servers/xmtp) " +
            "and RESOURCE_AGENT_ADDRESS matches the server's agent.address.",
        ),
      );
    }, 30_000);

    agent.on("text", async (ctx) => {
      logIncoming(ctx.message);
      clearTimeout(timeout);
      console.log("Response:", ctx.message.content);
      resolve();
    });
  });

  agent.on("start", () => {
    console.log(`Client ready at ${agent.address}`);
    console.log(`🔗 ${getTestUrl(agent.client)}`);
  });

  const inboxId = await agent.client.fetchInboxIdByIdentifier({
    identifier: resourceAgentAddress,
    identifierKind: IdentifierKind.Ethereum,
  });

  if (!inboxId) {
    throw new Error("Could not resolve RESOURCE_AGENT_ADDRESS to an XMTP inbox ID.");
  }

  const conversation = await agent.client.conversations.createDm(inboxId);

  await agent.start();

  console.log(`\nSending /weather to ${resourceAgentAddress}...`);
  await conversation.sendText("/weather");

  await responsePromise;
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
