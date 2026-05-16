import { convertToTokenAmount } from "@x402/core/utils";

export const NETWORK = "eip155:84532";
export const CHAIN_ID = 84532;

export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const USDC_DECIMALS = 6;

export const DEPOSIT_AMOUNT = "$0.01";
export const JUMP_PRICE = "$0.001";
export const BANK_PENALTY_MULTIPLIER = 2;

export const DEPOSIT_AMOUNT_UNITS = BigInt(
  convertToTokenAmount(DEPOSIT_AMOUNT.slice(1), USDC_DECIMALS),
);
export const JUMP_COST_UNITS = BigInt(convertToTokenAmount(JUMP_PRICE.slice(1), USDC_DECIMALS));

if (DEPOSIT_AMOUNT_UNITS % JUMP_COST_UNITS !== 0n) {
  throw new Error("Deposit amount must be a whole multiple of the jump price");
}

export const DEPOSIT_MULTIPLIER = Number(DEPOSIT_AMOUNT_UNITS / JUMP_COST_UNITS);

export const WITHDRAW_DELAY = 900; // 15 minutes (minimum)

export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ||
  process.env.NEXT_PUBLIC_FACILITATOR_URL ||
  "https://x402.org/facilitator";

export const RECEIVER_ADDRESS = (process.env.EVM_ADDRESS ||
  process.env.NEXT_PUBLIC_RECEIVER_ADDRESS ||
  "") as `0x${string}`;

export const SKIP_DEPOSIT = process.env.NEXT_PUBLIC_SKIP_DEPOSIT === "true";
