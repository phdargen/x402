import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type AuthorizerSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, nonceManager, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { zeroAddress } from "viem";

dotenv.config();

const PORT = process.env.PORT || "4022";

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const evmRpcUrl = process.env.EVM_RPC_URL?.trim() || "https://sepolia.base.org";

/** Log RPC host only — URLs may embed API keys. */
function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid EVM_RPC_URL)";
  }
}

const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY?.trim();

const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`, {
  nonceManager,
});

let authorizerSigner: AuthorizerSigner | undefined;
if (receiverAuthorizerPrivateKey) {
  const authorizerAccount = privateKeyToAccount(
    receiverAuthorizerPrivateKey as `0x${string}`,
  );
  authorizerSigner = {
    address: authorizerAccount.address,
    signTypedData: params =>
      authorizerAccount.signTypedData(
        params as Parameters<typeof authorizerAccount.signTypedData>[0],
      ),
  };
}

const feeRecipient = (process.env.FEE_RECIPIENT?.trim() || zeroAddress) as `0x${string}`;
const minFeeBps = Number(process.env.MIN_FEE_BPS ?? "0");
const maxFeeBps = Number(process.env.MAX_FEE_BPS ?? "0");

console.info(`EVM RPC: ${rpcHost(evmRpcUrl)}`);
console.info(`EVM Facilitator relayer: ${evmAccount.address}`);
if (authorizerSigner) {
  console.info(`EVM Receiver authorizer: ${authorizerSigner.address}`);
} else {
  console.info("EVM Receiver authorizer: not configured");
}

const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(evmRpcUrl),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  address: evmAccount.address,
  getCode: args => viemClient.getCode(args),
  readContract: args =>
    viemClient.readContract({ ...args, args: args.args ?? [] } as Parameters<
      typeof viemClient.readContract
    >[0]),
  verifyTypedData: args =>
    viemClient.verifyTypedData(
      args as Parameters<typeof viemClient.verifyTypedData>[0],
    ),
  writeContract: args =>
    viemClient.writeContract(
      args as Parameters<typeof viemClient.writeContract>[0],
    ),
  sendTransaction: args =>
    viemClient.sendTransaction(
      args as Parameters<typeof viemClient.sendTransaction>[0],
    ),
  waitForTransactionReceipt: args => viemClient.waitForTransactionReceipt(args),
});

const facilitator = new x402Facilitator();

facilitator.register(
  "eip155:84532",
  new AuthCaptureEvmScheme(evmSigner, {
    ...(authorizerSigner ? { receiverAuthorizer: authorizerSigner.address } : {}),
    ...(minFeeBps > 0 || maxFeeBps > 0 || feeRecipient !== zeroAddress
      ? { feeTerms: { feeRecipient, minFeeBps, maxFeeBps } }
      : {}),
    operators: [{ address: "*", operatorType: "custom" }],
    refundFunding: false,
  }),
);

const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements.
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

/**
 * POST /settle
 * Settle a payment onchain.
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const payload = paymentPayload as PaymentPayload;
    const requirements = paymentRequirements as PaymentRequirements;
    const payloadType = (payload.payload as { type?: string }).type ?? "collect";

    const response: SettleResponse = await facilitator.settle(payload, requirements);

    console.info(
      `[settle] type=${payloadType} requirements.amount=${requirements.amount}`,
      JSON.stringify(response, null, 2),
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

/**
 * GET /supported
 * Get supported payment kinds and extensions.
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

app.listen(parseInt(PORT), () => {
  console.log(`Auth-capture facilitator listening on http://localhost:${PORT}`);
  console.log(`  Relayer (extra.captureAuthorizer for delegated): ${evmAccount.address}`);
});
