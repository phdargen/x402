import type { Config } from "./types";

/** Overrides for embedding and testing. Every field defaults to the real process. */
export interface RunOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
  /** Whether stdin is a TTY. The CLI never prompts when false. */
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * Runs the `x402` CLI. Other packages call this from their own bin with a custom wallet.
 *
 * @param defaults - Config defaults; the loaded config file overrides them field by field
 * @param options - Argv and IO overrides
 */
export async function runCli(defaults: Config = {}, options: RunOptions = {}): Promise<void> {
  // Lazy so importing the library does not load incur or the command tree.
  const { serve } = await import("./cli/index");
  await serve(defaults, options);
}
