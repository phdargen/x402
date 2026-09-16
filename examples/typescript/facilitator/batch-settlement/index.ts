/**
 * Batch-settlement facilitator example (EVM + SVM)
 *
 * Registers the `batch-settlement` scheme on Base Sepolia and/or Solana Devnet.
 * For SVM, wires {@link BatchSvmRentCleanupManager} to the scheme's channel
 * storage so abandoned channels are sealed and rent is reclaimed asynchronously.
 */

import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network } from "@x402/core/types";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type AuthorizerSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { decodeClaimAttestation } from "@x402/evm/batch-settlement";
import {
  BatchSettlementEvmScheme,
  InMemoryChannelStorage,
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
import { toFacilitatorSvmSigner } from "@x402/svm";
import {
  BatchSvmRentCleanupManager,
  BatchSvmScheme,
  InMemoryBatchChannelStorage,
  type RentCleanupCloseResult,
  type RentCleanupReclaimResult,
} from "@x402/svm/batch-settlement/facilitator";
import dotenv from "dotenv";
import express from "express";
import {
  createWalletClient,
  http,
  nonceManager,
  parseEventLogs,
  publicActions,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

const refundedEventABI = [
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
    ],
  },
] as const;

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

/**
 * Logs claim attestation for a settlement transaction using the single SDK helper
 * {@link decodeClaimAttestation} (handles `claim` and bundled `multicall([claim, refund])`).
 *
 * @param label - Log label (`Claim` for `onClaim`, `Refund` for `onRefund`).
 * @param result - Channel-manager result with the settlement transaction hash and network.
 * @param client - Viem client used to fetch the transaction and receipt.
 * @param client.getTransaction - Fetches a transaction by hash.
 * @param client.getTransactionReceipt - Fetches a transaction receipt by hash.
 */
async function logSettlementAttestation(
  label: "Claim" | "Refund",
  result: FacilitatorClaimResult | FacilitatorRefundResult,
  client: {
    getTransaction: (args: { hash: Hex }) => Promise<{ input: Hex }>;
    getTransactionReceipt: (args: {
      hash: Hex;
    }) => Promise<{ logs: readonly unknown[] }>;
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
  const attestation = decodeClaimAttestation(
    tx.input,
    receipt.logs,
    result.network,
  );
  const builderCode = parseBuilderCodeSuffixFromCalldata(tx.input);

  if (label === "Refund") {
    const refunded = parseEventLogs({
      abi: refundedEventABI,
      eventName: "Refunded",
      logs: receipt.logs as Parameters<typeof parseEventLogs>[0]["logs"],
    });
    const channel = (result as FacilitatorRefundResult).channel;
    const refundLog = refunded.find(
      (entry) => entry.args.channelId?.toLowerCase() === channel.toLowerCase(),
    );
    console.log("[voucher store] Refund attestation", {
      tx: hash,
      channelId: channel,
      functionName: attestation.functionName,
      claimFunctionName: attestation.claimFunctionName ?? null,
      chargeCounts:
        attestation.chargeCounts?.map((count: bigint) => count.toString()) ??
        null,
      builderCode: builderCode ?? null,
      channels: attestation.channels,
      refundAmount: refundLog?.args.amount?.toString(),
      refundSender: refundLog?.args.sender,
    });
    return;
  }

  console.log("[voucher store] Claim attestation", {
    tx: hash,
    functionName: attestation.functionName,
    claimFunctionName: attestation.claimFunctionName ?? null,
    chargeCounts:
      attestation.chargeCounts?.map((count: bigint) => count.toString()) ??
      null,
    builderCode: builderCode ?? null,
    channels: attestation.channels,
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
const EVM_NETWORK = "eip155:84532" as Network;
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;

const evmPrivateKey = process.env.EVM_PRIVATE_KEY?.trim();
const svmPrivateKey = process.env.SVM_PRIVATE_KEY?.trim();
const evmRpcUrl = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";
const svmRpcUrl = process.env.SVM_RPC_URL;
const voucherStoreEnabled = envFlag("VOUCHER_STORE");
const voucherStoreDir = process.env.VOUCHER_STORE_DIR?.trim();
const voucherStoreWithdrawDelay = Number(
  process.env.VOUCHER_STORE_WITHDRAW_DELAY_SECONDS ?? "900",
);

// Validate required environment variables
if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// Treat unset or blank as not configured
const receiverAuthorizerPrivateKey =
  process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();

if (voucherStoreEnabled && !evmPrivateKey) {
  console.error("❌ VOUCHER_STORE requires EVM_PRIVATE_KEY (EVM only)");
  process.exit(1);
}

if (voucherStoreEnabled && !receiverAuthorizerPrivateKey) {
  console.error(
    "❌ VOUCHER_STORE requires EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (facilitator-managed custody)",
  );
  process.exit(1);
}

const rentCleanupIntervalSecs = Number.parseInt(
  process.env.RENT_CLEANUP_INTERVAL_SECS ?? "30",
  10,
);
const abandonGraceSecs = Number.parseInt(
  process.env.RENT_CLEANUP_ABANDON_GRACE_SECS ?? "120",
  10,
);

const channelStorage = new InMemoryBatchChannelStorage();
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

let rentCleanupManager: BatchSvmRentCleanupManager | undefined;
let voucherStoreChannelManager: FacilitatorChannelManager | undefined;

if (evmPrivateKey) {
  // Initialize the EVM account from private key (submits transactions)
  const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`, {
    nonceManager,
  });

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

  // Create a Viem client with both wallet and public capabilities
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

  if (voucherStoreEnabled) {
    const backend = voucherStoreDir ? `file (${voucherStoreDir})` : "in-memory";
    console.info(
      `Facilitator voucher store: enabled (${backend}, withdrawDelay ${voucherStoreWithdrawDelay}s)`,
    );
  } else {
    console.info("Facilitator voucher store: disabled (self-managed server custody)");
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

  // Register EVM scheme (batched: deposit / voucher / claim / settle)
  facilitator.register(EVM_NETWORK, batchSettlementScheme); // Base Sepolia

  if (voucherStoreEnabled) {
    voucherStoreChannelManager = batchSettlementScheme.createChannelManager({
      getExtension: (key: string) => facilitator.getExtension(key),
    });
    voucherStoreChannelManager.start({
      claimIntervalSecs: 60,
      settleIntervalSecs: 120,
      refundIntervalSecs: 180,
      refundIdleSecs: 180,
      maxClaimsPerBatch: 100,
      onClaim: (r: FacilitatorClaimResult) => {
        console.log(`[voucher store] Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`);
        void logSettlementAttestation("Claim", r, viemClient).catch(err =>
          console.error("[voucher store] Failed to parse claim attestation:", err),
        );
      },
      onSettle: (r: FacilitatorSettleResult) =>
        console.log(`[voucher store] Settled ${r.receiver} (tx: ${r.transaction})`),
      onRefund: (r: FacilitatorRefundResult) => {
        console.log(`[voucher store] Refunded channel ${r.channel} (tx: ${r.transaction})`);
        void logSettlementAttestation("Refund", r, viemClient).catch(err =>
          console.error("[voucher store] Failed to parse refund attestation:", err),
        );
      },
      onError: e => console.error("[voucher store] Settlement error:", e),
    });
  }
}

if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(
    svmAccount,
    svmRpcUrl ? { defaultRpcUrl: svmRpcUrl } : undefined,
  );
  const svmBatchScheme = new BatchSvmScheme(svmSigner, {
    channelStorage,
  });
  facilitator.register(SVM_NETWORK, svmBatchScheme);

  rentCleanupManager = svmBatchScheme.createRentCleanupManager(SVM_NETWORK);
  rentCleanupManager.start({
    intervalSecs: rentCleanupIntervalSecs,
    abandonGraceSecs,
    onClose: (result: RentCleanupCloseResult) => {
      console.info(
        `[rent-cleanup] ${result.action} channel=${result.channelId} tx=${result.transaction}`,
      );
    },
    onReclaim: (result: RentCleanupReclaimResult) => {
      console.info(
        `[rent-cleanup] reclaim channels=${result.channelIds.join(",")} tx=${result.transaction}`,
      );
    },
    onError: (error: unknown, context?: { channelId?: string }) => {
      console.error("[rent-cleanup] error", {
        channelId: context?.channelId,
        error: error instanceof Error ? error.message : error,
      });
    },
  });
  console.info(
    `SVM rent cleanup started (interval=${rentCleanupIntervalSecs}s, abandonGrace=${abandonGraceSecs}s)`,
  );
}

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
app.get("/supported", async (_req, res) => {
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

const enabledNetworks = [
  evmPrivateKey ? "EVM (Base Sepolia)" : null,
  svmPrivateKey ? "Solana (devnet)" : null,
]
  .filter(Boolean)
  .join(", ");

// Start the server
app.listen(parseInt(PORT), () => {
  console.log(
    `🚀 Batch-settlement facilitator listening on http://localhost:${PORT}`,
  );
  console.log(`   Networks: ${enabledNetworks}`);
  console.log();
});

async function shutdown(): Promise<void> {
  await rentCleanupManager?.stop();
  if (voucherStoreChannelManager) {
    console.log("Shutting down — flushing voucher-store claims…");
    await voucherStoreChannelManager.stop({ flush: true });
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
