/**
 * Facilitator with Builder Code (ERC-8021) Extension Example
 *
 * Demonstrates how to create a facilitator that registers its own builder codes
 * for on-chain attribution. During settlement, the mechanism collects codes from
 * both the server (declared in PaymentRequired) and the facilitator (registered
 * here), then appends them as an ERC-8021 calldata suffix.
 *
 * Required environment variables:
 * - EVM_PRIVATE_KEY: Private key for the EVM facilitator wallet
 * - PORT: (optional) Port to listen on (default 4022)
 */

import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createBuilderCodeFacilitatorExtension } from "@x402/extensions";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

const PORT = process.env.PORT || "4022";

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("Missing EVM_PRIVATE_KEY environment variable");
  process.exit(1);
}

const EVM_NETWORK = "eip155:84532"; // Base Sepolia

// Register the facilitator's own builder codes for on-chain attribution.
// These are combined with server-declared codes during settlement.
const facilitator = new x402Facilitator()
  .registerExtension(
    createBuilderCodeFacilitatorExtension({
      [EVM_NETWORK]: "my-facilitator",
    }),
  )
  .onAfterSettle(async context => {
    console.log(`Payment settled: ${context.result.transaction}`);
  })
  .onSettleFailure(async context => {
    console.log("Settle failure", context);
  });

const evmAccount = privateKeyToAccount(evmPrivateKey);
console.info(`EVM Facilitator account: ${evmAccount.address}`);

const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  address: evmAccount.address,
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
});

facilitator.register(
  EVM_NETWORK,
  new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
);

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

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(parseInt(PORT), () => {
  console.log(`Builder Code Facilitator listening on http://localhost:${PORT}`);
  console.log(`   Supported networks: ${facilitator.getSupported().kinds.map(k => k.network).join(", ")}`);
  console.log(`   Builder codes will be appended as ERC-8021 calldata suffix during settlement`);
  console.log();
});
