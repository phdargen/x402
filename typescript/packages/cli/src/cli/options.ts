import { z } from "incur";

export const configOption = z
  .string()
  .optional()
  .describe(
    "Config file (.json, .ts, .mjs). Defaults to $X402_CONFIG, then ~/.config/x402/config.json",
  );

export const accountOption = z
  .string()
  .optional()
  .describe("Account name. Defaults to $X402_ACCOUNT, then config.account, then default");

export const walletOption = z
  .string()
  .optional()
  .describe("Wallet id: local, keychain, or one registered in config. Defaults to $X402_WALLET");

export const familiesOption = z
  .array(z.string())
  .optional()
  .describe(
    "Network family, repeatable (evm, svm). Defaults to config.families, then the account's families",
  );

export const familyOption = z.string().optional().describe("Network family (evm, svm)");

export const yesOption = z.boolean().optional().describe("Skip the confirmation prompt");

export const rpcOption = z
  .array(z.string())
  .optional()
  .describe(
    "RPC override <network>=<url>, repeatable. Wins over $X402_RPC, then config.rpc, per network",
  );

/**
 * A help example shown verbatim after the command path.
 *
 * @param command - Arguments and flags exactly as a user would type them
 * @param description - What the example does
 * @returns An incur example
 */
export function example(command: string, description: string): never {
  // incur prints typed example options as `--camelCase value` without shell quoting,
  // so the whole command line travels as a single positional value instead.
  return { args: { command }, description } as never;
}
