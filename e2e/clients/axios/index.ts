import { config } from "dotenv";
import axios from "axios";
import { wrapAxiosWithPayment, decodePaymentResponseHeader } from "@x402/axios";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { ExactEvmScheme, type ExactEvmSchemeOptions } from "@x402/evm/exact/client";
import {
  UptoEvmScheme as UptoEvmClientScheme,
  type UptoEvmSchemeOptions,
} from "@x402/evm/upto/client";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { ExactAptosScheme } from "@x402/aptos/exact/client";
import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { createClientHederaSigner, PrivateKey as HederaPrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, type Ed25519Signer } from "@x402/stellar";
import { ExactAvmScheme as ExactAvmClientScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client } from "@x402/core/client";

config();

const baseURL = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string;
const url = `${baseURL}${endpointPath}`;
const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const svmSigner = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY as string),
);

const evmNetwork = process.env.EVM_NETWORK || "eip155:84532";
const evmRpcUrl = process.env.EVM_RPC_URL;
const evmChain = evmNetwork === "eip155:8453" ? base : baseSepolia;

const publicClient = createPublicClient({
  chain: evmChain,
  transport: http(evmRpcUrl),
});

const evmSigner = toClientEvmSigner(evmAccount, publicClient);

const evmSchemeOptions: ExactEvmSchemeOptions | undefined = process.env.EVM_RPC_URL
  ? { rpcUrl: process.env.EVM_RPC_URL }
  : undefined;

const uptoSchemeOptions: UptoEvmSchemeOptions | undefined = process.env.EVM_RPC_URL
  ? { rpcUrl: process.env.EVM_RPC_URL }
  : undefined;

// Batch-settlement scheme uses a per-scenario salt (CHANNEL_SALT) so concurrent
// e2e runs don't collide on the same on-chain channel id. An optional voucher
// signer (EVM_VOUCHER_SIGNER_PRIVATE_KEY) exercises the alt-EOA voucher branch
// while deposits keep using the main client signer.
const channelSalt = process.env.CHANNEL_SALT as `0x${string}` | undefined;
const voucherSignerKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const voucherSigner = voucherSignerKey
  ? toClientEvmSigner(privateKeyToAccount(voucherSignerKey), publicClient)
  : undefined;
const batchSettlementOptions =
  channelSalt || voucherSigner
    ? { ...(channelSalt ? { salt: channelSalt } : {}), ...(voucherSigner ? { voucherSigner } : {}) }
    : undefined;
const batchSettlementScheme = new BatchSettlementEvmScheme(evmSigner, batchSettlementOptions);

// Initialize Aptos signer if key is provided
let aptosAccount: Account | undefined;
if (process.env.APTOS_PRIVATE_KEY) {
  const formattedKey = PrivateKey.formatPrivateKey(
    process.env.APTOS_PRIVATE_KEY,
    PrivateKeyVariants.Ed25519,
  );
  const aptosPrivateKey = new Ed25519PrivateKey(formattedKey);
  aptosAccount = Account.fromPrivateKey({ privateKey: aptosPrivateKey });
}

// Initialize Hedera signer if account + key are provided
let hederaClientSigner: ReturnType<typeof createClientHederaSigner> | undefined;
if (process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY) {
  hederaClientSigner = createClientHederaSigner(
    process.env.HEDERA_ACCOUNT_ID,
    HederaPrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY),
    {
      network: process.env.HEDERA_NETWORK || "hedera:testnet",
      nodeUrl: process.env.HEDERA_NODE_URL || undefined,
    },
  );
}

// Initialize Stellar signer if key is provided
let stellarSigner: Ed25519Signer | undefined;
if (process.env.STELLAR_PRIVATE_KEY) {
  stellarSigner = createEd25519Signer(process.env.STELLAR_PRIVATE_KEY);
}

// Initialize AVM signer if key is provided
let avmSigner: ReturnType<typeof toClientAvmSigner> | undefined;
if (process.env.AVM_PRIVATE_KEY) {
  avmSigner = toClientAvmSigner(process.env.AVM_PRIVATE_KEY);
}

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmSigner, evmSchemeOptions))
  .register("eip155:*", new UptoEvmClientScheme(evmSigner, uptoSchemeOptions))
  .register("eip155:*", batchSettlementScheme)
  .registerV1("base-sepolia", new ExactEvmSchemeV1(evmSigner))
  .registerV1("base", new ExactEvmSchemeV1(evmSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner))
  .registerV1("solana-devnet", new ExactSvmSchemeV1(svmSigner))
  .registerV1("solana", new ExactSvmSchemeV1(svmSigner));
if (aptosAccount) {
  client.register("aptos:*", new ExactAptosScheme(aptosAccount));
}
if (hederaClientSigner) {
  client.register("hedera:*", new ExactHederaScheme(hederaClientSigner));
}
if (stellarSigner) {
  client.register("stellar:*", new ExactStellarScheme(stellarSigner));
}
if (avmSigner) {
  client.register("algorand:*", new ExactAvmClientScheme(avmSigner));
}

const axiosWithPayment = wrapAxiosWithPayment(axios.create(), client);

// Multi-request scenarios (used by batch-settlement) 
const numberOfRequests = Number.parseInt(process.env.MULTI_REQUEST_COUNT ?? "1", 10);
const refundAfterRequests = process.env.REFUND_ON_LAST ?? "true";

/**
 * Issues a single paid request and returns the parsed result.
 *
 * @returns Structured result with response data and decoded payment-response.
 */
async function issueRequest(): Promise<{
  success: boolean;
  data: unknown;
  status_code: number;
  payment_response?: ReturnType<typeof decodePaymentResponseHeader>;
}> {
  const response = await axiosWithPayment.get(url);
  const paymentResponseHeader =
    response.headers["payment-response"] || response.headers["x-payment-response"];

  if (!paymentResponseHeader) {
    return { success: true, data: response.data, status_code: response.status };
  }

  const decodedPaymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
  return {
    success: decodedPaymentResponse.success,
    data: response.data,
    status_code: response.status,
    payment_response: decodedPaymentResponse,
  };
}

try {
  const results: Awaited<ReturnType<typeof issueRequest>>[] = [];
  for (let i = 0; i < numberOfRequests; i++) {
    const result = await issueRequest();
    results.push(result);
  }

  if (refundAfterRequests) {
    const refundSettle = await batchSettlementScheme.refund(url);
    results.push({
      success: refundSettle.success,
      data: { refund: true },
      status_code: 200,
      payment_response: refundSettle,
    });
  }

  const last = results[results.length - 1]!;
  const aggregate =
    numberOfRequests > 1
      ? { ...last, requests: results, request_count: numberOfRequests }
      : last;

  console.log(JSON.stringify(aggregate));
  process.exit(0);
} catch (error: unknown) {
  const err = error as { message?: string; response?: { status?: number } };
  console.error(
    JSON.stringify({
      success: false,
      error: err.message || "Request failed",
      status_code: err.response?.status || 500,
    }),
  );
  process.exit(1);
}
