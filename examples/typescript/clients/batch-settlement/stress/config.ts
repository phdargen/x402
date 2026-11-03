import { keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Base Sepolia batch-settlement contract (CREATE2, same on all chains). */
export const BATCH_SETTLEMENT_ADDRESS = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" as const;
export const NETWORK = "eip155:84532" as const;
/** Channel salts must fit in 96 bits so managed-mode packing keeps them distinct. */
const UINT96_MAX = (1n << 96n) - 1n;
const MAX_CBBTC_BUDGET_ATOMIC = 100_000n;

export type StressConfig = {
  evmPrivateKey: `0x${string}`;
  seed: string;
  baseUrl: string;
  rpcUrl: string | undefined;
  channels: number;
  /** Offered payments per second during the steady phase. */
  rps: number;
  durationMs: number;
  /** Maximum number of initial channel deposits in flight during the opening ramp. */
  openConcurrency: number;
  maxInflight: number;
  drainTimeoutMs: number;
  /** Share of channels that use cbBTC instead of USDC, 0-1. */
  cbbtcShare: number;
  /** Maximum cbBTC amount reserved by deposit authorizations, in atomic units. */
  cbbtcBudgetAtomic: bigint;
  /** Share of steady-phase traffic aimed at Zipf-hot channels, 0-1. */
  hotShare: number;
  zipfS: number;
  depositMultiplier: number;
  /** Probability of requesting a partial refund after a successful voucher. */
  refundProbability: number;
  /** Fraction of the channel's refundable balance requested by a refund. */
  refundFraction: number;
  /** Smallest partial refund amount in token atomic units. */
  refundMinAtomic: bigint;
  reportDir: string;
  progressIntervalMs: number;
  drainPollIntervalMs: number;
};

/**
 * Parses a duration such as `90s`, `10m`, `2h` or plain milliseconds.
 *
 * @param raw - Raw duration text.
 * @param name - Variable name for error messages.
 * @returns The duration in milliseconds.
 */
export function parseDuration(raw: string, name: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must look like 500ms, 90s, 10m or 2h, got "${raw}"`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit] as number;
  return value * factor;
}

/**
 * Reads a numeric environment variable with a default and range check.
 *
 * @param name - Variable name.
 * @param fallback - Value used when the variable is unset.
 * @param min - Smallest accepted value.
 * @param max - Largest accepted value.
 * @returns The parsed number.
 */
function numberEnv(name: string, fallback: number, min: number, max = Infinity): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

/**
 * Loads and validates the stress configuration from the environment.
 *
 * @returns The validated configuration.
 */
export function loadConfig(): StressConfig {
  const evmPrivateKey = process.env.EVM_PRIVATE_KEY?.trim();
  if (!evmPrivateKey) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
  }
  const channels = numberEnv("STRESS_CHANNELS", 1000, 1);
  if (!Number.isInteger(channels) || BigInt(channels) > UINT96_MAX) {
    throw new Error("STRESS_CHANNELS must be a positive integer");
  }
  const cbbtcBudgetAtomic = parseAtomicBudget(
    process.env.STRESS_CBBTC_BUDGET_ATOMIC ?? MAX_CBBTC_BUDGET_ATOMIC.toString(),
    "STRESS_CBBTC_BUDGET_ATOMIC",
  );
  if (cbbtcBudgetAtomic > MAX_CBBTC_BUDGET_ATOMIC) {
    throw new Error(
      `STRESS_CBBTC_BUDGET_ATOMIC cannot exceed ${MAX_CBBTC_BUDGET_ATOMIC} atomic units (0.001 cbBTC)`,
    );
  }
  return {
    evmPrivateKey: evmPrivateKey as `0x${string}`,
    seed: process.env.STRESS_SEED?.trim() || "x402-stress-default-seed",
    baseUrl: (process.env.RESOURCE_SERVER_URL?.trim() || "http://localhost:4022").replace(
      /\/$/,
      "",
    ),
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL?.trim() || undefined,
    channels,
    rps: numberEnv("STRESS_RPS", 5, 0.001),
    durationMs: parseDuration(process.env.STRESS_DURATION ?? "10m", "STRESS_DURATION"),
    openConcurrency: numberEnv("STRESS_OPEN_CONCURRENCY", 8, 1),
    maxInflight: numberEnv("STRESS_MAX_INFLIGHT", 64, 1),
    drainTimeoutMs: parseDuration(
      process.env.STRESS_DRAIN_TIMEOUT ?? "15m",
      "STRESS_DRAIN_TIMEOUT",
    ),
    cbbtcShare: numberEnv("STRESS_CBBTC_SHARE", 0.01, 0, 1),
    cbbtcBudgetAtomic,
    hotShare: numberEnv("STRESS_HOT_SHARE", 0.7, 0, 1),
    zipfS: numberEnv("STRESS_ZIPF_S", 1.1, 0),
    depositMultiplier: numberEnv("DEPOSIT_MULTIPLIER", 20, 3),
    refundProbability: numberEnv("STRESS_REFUND_PROBABILITY", 0.005, 0, 1),
    refundFraction: numberEnv("STRESS_REFUND_FRACTION", 0.05, 0, 1),
    refundMinAtomic: parseAtomicBudget(
      process.env.STRESS_REFUND_MIN_ATOMIC ?? "1",
      "STRESS_REFUND_MIN_ATOMIC",
    ),
    reportDir: process.env.STRESS_REPORT_DIR?.trim() || ".",
    progressIntervalMs: parseDuration(
      process.env.STRESS_PROGRESS_INTERVAL ?? "30s",
      "STRESS_PROGRESS_INTERVAL",
    ),
    drainPollIntervalMs: parseDuration(
      process.env.STRESS_DRAIN_POLL_INTERVAL ?? "15s",
      "STRESS_DRAIN_POLL_INTERVAL",
    ),
  };
}

/**
 * Derives the unfunded voucher signer for a channel. The key is a pure function of the seed and
 * the channel index, so re-running with the same seed resumes the same channels.
 *
 * @param seed - Stress seed.
 * @param index - Channel index.
 * @returns The voucher signer account.
 */
export function deriveVoucherSigner(seed: string, index: number) {
  return privateKeyToAccount(keccak256(encodePacked(["string", "uint256"], [seed, BigInt(index)])));
}

/**
 * Parses a positive atomic-unit budget.
 *
 * @param raw - Raw budget value.
 * @param name - Environment variable name.
 * @returns The budget in atomic units.
 */
function parseAtomicBudget(raw: string, name: string): bigint {
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer in atomic units`);
  }
  return BigInt(raw);
}

/**
 * Chooses the token for a channel. Spreading cbBTC evenly keeps every receiver on both tokens.
 *
 * @param index - Channel index.
 * @param cbbtcShare - Share of cbBTC channels, 0-1.
 * @returns `cbbtc` or `usdc`.
 */
export function tokenKeyForChannel(index: number, cbbtcShare: number): "usdc" | "cbbtc" {
  return index % 100 < Math.round(cbbtcShare * 100) ? "cbbtc" : "usdc";
}
