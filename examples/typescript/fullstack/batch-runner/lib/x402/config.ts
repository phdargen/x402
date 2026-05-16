import { convertToTokenAmount } from "@x402/core/utils";

export const NETWORK = "eip155:84532";
export const CHAIN_ID = 84532;
export const NEXT_DEV = process.env.NEXT_DEV === "true";

export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const USDC_DECIMALS = 6;
const DEV_RECEIVER_ADDRESS = "0x0000000000000000000000000000000000000001";

export const PLAY_PRICE = "$0.01";
export const JUMP_PRICE = "$0.001";
export const MIN_PLAY_CREDITS = 1;
export const MAX_PLAY_CREDITS = 10;
export const BANK_PENALTY_MULTIPLIER = 2;

export const PLAY_PRICE_UNITS = BigInt(convertToTokenAmount(PLAY_PRICE.slice(1), USDC_DECIMALS));
export const JUMP_COST_UNITS = BigInt(convertToTokenAmount(JUMP_PRICE.slice(1), USDC_DECIMALS));

if (PLAY_PRICE_UNITS % JUMP_COST_UNITS !== 0n) {
  throw new Error("Play price must be a whole multiple of the jump price");
}

export const JUMPS_PER_PLAY = Number(PLAY_PRICE_UNITS / JUMP_COST_UNITS);
export const VOUCHER_CHECKPOINT_JUMPS = 5;

export const WITHDRAW_DELAY = 900; // 15 minutes (minimum)
export const STORAGE_DIR = process.env.STORAGE_DIR || "/tmp/x402-batch-runner-channels";

export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ||
  process.env.NEXT_PUBLIC_FACILITATOR_URL ||
  "https://x402.org/facilitator";

export const RECEIVER_ADDRESS = (process.env.EVM_ADDRESS ||
  process.env.NEXT_PUBLIC_RECEIVER_ADDRESS ||
  (NEXT_DEV ? DEV_RECEIVER_ADDRESS : "") ||
  "") as `0x${string}`;
