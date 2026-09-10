import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type AuthorizerSigner, toFacilitatorEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  InMemoryChannelStorage,
  batchSettlementABI,
  computeChannelId,
  parseChargeCountsFromCalldata,
  type FacilitatorChannelManager,
  type FacilitatorClaimResult,
  type FacilitatorRefundResult,
  type FacilitatorSettleResult,
} from "@x402/evm/batch-settlement/facilitator";
import { FileChannelStorage } from "@x402/evm/batch-settlement/facilitator/file-storage";
import {
  BuilderCodeFacilitatorExtension,
  parseBuilderCodeSuffixFromCalldata,
} from "@x402/extensions/builder-code";
import dotenv from "dotenv";
import express from "express";
import {
  createWalletClient,
  decodeFunctionData,
  http,
  nonceManager,
  parseEventLogs,
  publicActions,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function debugLog(...args: unknown[]): void {
  if (envFlag("DEBUG")) {
    console.log(...args);
  }
}

function batchPayloadType(payload: PaymentPayload): string {
  const body = payload.payload as { type?: string } | undefined;
  return typeof body?.type === "string" ? body.type : "unknown";
}

function logVerifyLine(payload: PaymentPayload, response: VerifyResponse): void {
  const type = batchPayloadType(payload);
  if (response.isValid) {
    console.info(`POST /verify ${type} ok`);
    return;
  }
  console.info(
    `POST /verify ${type} failed ${response.invalidReason ?? "unknown"}${
      response.invalidMessage ? `: ${response.invalidMessage}` : ""
    }`,
  );
}

async function logClaimAttestation(
  result: FacilitatorClaimResult,
  client: {
    getTransaction: (args: { hash: Hex }) => Promise<{ input: Hex }>;
    getTransactionReceipt: (args: { hash: Hex }) => Promise<{ logs: readonly unknown[] }>;
  },
): Promise<void> {
  if (!result.transaction) {
    return;
  }
  const hash = result.transaction as Hex;
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ]);
  const chargeCounts = parseChargeCountsFromCalldata(tx.input);
  const builderCode = parseBuilderCodeSuffixFromCalldata(tx.input);
  const decoded = decodeFunctionData({ abi: batchSettlementABI, data: tx.input });
  if (decoded.functionName !== "claim" && decoded.functionName !== "claimWithSignature") {
    console.log("[voucher store] Claim attestation: not a claim function", {
      tx: hash,
      functionName: decoded.functionName,
    });
    return;
  }
  const voucherClaims = decoded.args[0];
  const claimed = parseEventLogs({
    abi: batchSettlementABI,
    eventName: "Claimed",
    logs: receipt.logs as Parameters<typeof parseEventLogs>[0]["logs"],
  });
  const rows = voucherClaims.map((claim: (typeof voucherClaims)[number], index: number) => {
    const channelId = computeChannelId(
      {
        ...claim.voucher.channel,
        withdrawDelay: Number(claim.voucher.channel.withdrawDelay),
      },
      result.network,
    );
    const log = claimed.find(
      entry => entry.args.channelId?.toLowerCase() === channelId.toLowerCase(),
    );
    return {
      channelId,
      chargeCount: chargeCounts?.[index]?.toString(),
      claimAmount: log?.args.claimAmount?.toString(),
      newTotalClaimed: log?.args.newTotalClaimed?.toString(),
    };
  });
  console.log("[voucher store] Claim attestation", {
    tx: hash,
    chargeCounts: chargeCounts?.map((count: bigint) => count.toString()),
    builderCode: builderCode ?? null,
    channels: rows,
  });
}

function logSettleLine(payload: PaymentPayload, response: SettleResponse): void {
  const type = batchPayloadType(payload);
  if (response.success) {
    console.info(`POST /settle ${type} ok tx=${response.transaction}`);
    return;
  }
  console.info(
    `POST /settle ${type} failed ${response.errorReason ?? "unknown"}${
      response.errorMessage ? `: ${response.errorMessage}` : ""
    }`,
  );
}

// Configuration
const PORT = process.env.PORT || "4022";
const voucherStoreEnabled = envFlag("VOUCHER_STORE");
const voucherStoreDir = process.env.VOUCHER_STORE_DIR?.trim();
const voucherStoreWithdrawDelay = Number(
  process.env.VOUCHER_STORE_WITHDRAW_DELAY_SECONDS ?? "900",
);

// Validate required environment variables
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const evmRpcUrl = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";

// Treat unset or blank as not configured
const receiverAuthorizerPrivateKey =
  process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();

if (voucherStoreEnabled && !receiverAuthorizerPrivateKey) {
  console.error(
    "❌ VOUCHER_STORE requires EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (facilitator-managed custody)",
  );
  process.exit(1);
}

// Initialize the EVM account from private key (submits transactions)
const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
  { nonceManager },
);

// Optional receiverAuthorizer (signs ClaimBatch / Refund EIP-712 messages)
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
if (authorizerSigner) {
  console.info(`EVM Receiver Authorizer: ${authorizerSigner.address}`);
} else {
  console.info("EVM Receiver Authorizer: not configured");
}
if (voucherStoreEnabled) {
  const backend = voucherStoreDir ? `file (${voucherStoreDir})` : "in-memory";
  console.info(
    `Facilitator voucher store: enabled (${backend}, withdrawDelay ${voucherStoreWithdrawDelay}s)`,
  );
} else {
  console.info("Facilitator voucher store: disabled (self-managed server custody)");
}

// Create a Viem client with both wallet and public capabilities
const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(evmRpcUrl),
}).extend(publicActions);

// Initialize the x402 Facilitator with EVM support
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

const facilitator = new x402Facilitator()
  .onBeforeVerify(async context => {
    debugLog("Before verify", context);
  })
  .onAfterVerify(async context => {
    debugLog("After verify", context);
  })
  .onVerifyFailure(async context => {
    debugLog("Verify failure", context);
  })
  .onBeforeSettle(async context => {
    debugLog("Before settle", context);
  })
  .onAfterSettle(async context => {
    debugLog("After settle", context);
  })
  .onSettleFailure(async context => {
    debugLog("Settle failure", context);
  });

const facilitatorBuilderCode = process.env.FACILITATOR_BUILDER_CODE?.trim();
if (facilitatorBuilderCode) {
  facilitator.registerExtension(
    new BuilderCodeFacilitatorExtension({ builderCode: facilitatorBuilderCode }),
  );
  console.info(`Facilitator builder code: ${facilitatorBuilderCode}`);
}

const batchSettlementScheme = new BatchSettlementEvmScheme(evmSigner, authorizerSigner, {
  ...(voucherStoreEnabled
    ? {
        voucherStore: {
          storage: voucherStoreDir
            ? new FileChannelStorage({ directory: voucherStoreDir })
            : new InMemoryChannelStorage(),
          withdrawDelay: voucherStoreWithdrawDelay,
        },
      }
    : {}),
});

// Register EVM schemes (batched: deposit / voucher / claim / settle)
facilitator.register("eip155:84532", batchSettlementScheme); // Base Sepolia

let channelManager: FacilitatorChannelManager | undefined;
if (voucherStoreEnabled) {
  channelManager = batchSettlementScheme.createChannelManager({
    getExtension: (key: string) => facilitator.getExtension(key),
  });
  channelManager.start({
    claimIntervalSecs: 60,
    settleIntervalSecs: 120,
    refundIntervalSecs: 180,
    refundIdleSecs: 180,
    maxClaimsPerBatch: 100,
    onClaim: (r: FacilitatorClaimResult) => {
      console.log(`[voucher store] Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`);
      void logClaimAttestation(r, viemClient).catch(err =>
        console.error("[voucher store] Failed to parse claim attestation:", err),
      );
    },
    onSettle: (r: FacilitatorSettleResult) =>
      console.log(`[voucher store] Settled ${r.receiver} (tx: ${r.transaction})`),
    onRefund: (r: FacilitatorRefundResult) =>
      console.log(`[voucher store] Refunded channel ${r.channel} (tx: ${r.transaction})`),
    onError: e => console.error("[voucher store] Settlement error:", e),
  });
}

process.on("SIGINT", async () => {
  if (channelManager) {
    console.log("Shutting down — flushing voucher-store claims…");
    await channelManager.stop({ flush: true });
  }
  process.exit(0);
});

// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 *
 * Note: Payment tracking and bazaar discovery are handled by lifecycle hooks
 */
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

    // Hooks will automatically:
    // - Track verified payment (onAfterVerify)
    // - Extract and catalog discovery info (onAfterVerify)
    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    logVerifyLine(paymentPayload, response);
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * Settle a payment onchain
 *
 * Note: Verification validation and cleanup are handled by lifecycle hooks
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Validate payment was verified (onBeforeSettle - will abort if not)
    // - Check verification timeout (onBeforeSettle)
    // - Clean up tracking (onAfterSettle / onSettleFailure)
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    logSettleLine(paymentPayload as PaymentPayload, response);
    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      // Return a proper SettleResponse instead of 500 error
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

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(`🚀 Facilitator listening on http://localhost:${PORT}`);
  console.log();
});
