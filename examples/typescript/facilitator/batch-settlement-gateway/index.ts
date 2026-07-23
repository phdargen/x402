import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type AuthorizerSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import {
  createVoucherGatewayFacilitatorExtension,
  FileGatewayChannelStorage,
} from "@x402/evm/batch-settlement/gateway/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, nonceManager, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

const PORT = process.env.PORT || "4022";
const NETWORK = "eip155:84532" as const;

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const gatewayAddress = process.env.GATEWAY_ADDRESS?.trim() as
  | `0x${string}`
  | undefined;
if (!gatewayAddress || !/^0x[0-9a-fA-F]{40}$/.test(gatewayAddress)) {
  console.error(
    "❌ GATEWAY_ADDRESS environment variable is required (0x-prefixed address)",
  );
  process.exit(1);
}

const withdrawDelay = Number(process.env.WITHDRAW_DELAY_SECONDS ?? "900");
const evmRpcUrl = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";
const storageDir = process.env.STORAGE_DIR?.trim();
const autoClaim = process.env.AUTO_CLAIM !== "false";

const receiverAuthorizerPrivateKey =
  process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();

const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
  { nonceManager },
);

let authorizerSigner: AuthorizerSigner | undefined;
if (receiverAuthorizerPrivateKey) {
  const authorizerAccount = privateKeyToAccount(
    receiverAuthorizerPrivateKey as `0x${string}`,
  );
  authorizerSigner = {
    address: authorizerAccount.address,
    signTypedData: (params) =>
      authorizerAccount.signTypedData(
        params as Parameters<typeof authorizerAccount.signTypedData>[0],
      ),
  };
}

console.info(`EVM Facilitator account: ${evmAccount.address}`);
console.info(`Gateway: ${gatewayAddress}`);
console.info(`Withdraw delay: ${withdrawDelay}s`);
console.info(`Auto claim: ${autoClaim ? "enabled" : "disabled"}`);
if (authorizerSigner) {
  console.info(`EVM Receiver Authorizer: ${authorizerSigner.address}`);
} else {
  console.info("EVM Receiver Authorizer: not configured");
}

const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(evmRpcUrl),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  address: evmAccount.address,
  getCode: (args) => viemClient.getCode(args),
  readContract: (args) =>
    viemClient.readContract({ ...args, args: args.args ?? [] } as Parameters<
      typeof viemClient.readContract
    >[0]),
  verifyTypedData: (args) =>
    viemClient.verifyTypedData(
      args as Parameters<typeof viemClient.verifyTypedData>[0],
    ),
  writeContract: (args) =>
    viemClient.writeContract(
      args as Parameters<typeof viemClient.writeContract>[0],
    ),
  sendTransaction: (args) =>
    viemClient.sendTransaction(
      args as Parameters<typeof viemClient.sendTransaction>[0],
    ),
  waitForTransactionReceipt: (args) =>
    viemClient.waitForTransactionReceipt(args),
});

const voucherGateway = createVoucherGatewayFacilitatorExtension({
  gateway: gatewayAddress,
  withdrawDelay,
  ...(storageDir
    ? {
        storage: new FileGatewayChannelStorage(
          `${storageDir}/gateway-channels.json`,
        ),
      }
    : {}),
});

const facilitator = new x402Facilitator()
  .registerExtension(voucherGateway)
  .register(NETWORK, new BatchSettlementEvmScheme(evmSigner, authorizerSigner));

const channelManager = voucherGateway.createChannelManager(evmSigner, NETWORK);
if (autoClaim) {
  channelManager.start({
    distributeIntervalSecs: 60,
    maxClaimsPerBatch: 100,
    onDistribute: (r) =>
      console.log(
        `Distributed ${r.claims} claims across ${r.channels} channels (tx: ${r.transaction})`,
      ),
    onError: (e) => console.error("Distribute error:", e),
  });
}

process.on("SIGINT", async () => {
  console.log("Shutting down — flushing pending distributions…");
  await channelManager.stop({ flush: autoClaim });
  process.exit(0);
});

const app = express();
app.use(express.json());

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );
    console.log("Settle response", response);
    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", async (_req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Optional immediate redemption for local load tests (schedule still runs every 60s).
app.post("/distribute", async (_req, res) => {
  try {
    const result = await channelManager.distribute();
    res.json(result ?? { channels: 0, claims: 0, transaction: null });
  } catch (error) {
    console.error("Distribute error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`🚀 Gateway facilitator listening on http://localhost:${PORT}`);
  console.log();
});
