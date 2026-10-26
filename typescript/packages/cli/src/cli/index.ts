import { createInterface } from "node:readline/promises";
import { Cli } from "incur";
import type { RunOptions } from "../run";
import type { Config } from "../types";
import { accountCommands } from "./account";
import { balanceCommand } from "./balance";
import { configCommands } from "./config";
import { walletErrors, type Io, type Runtime } from "./context";
import { payCommand } from "./pay";
import { policyCommands } from "./policy";

/**
 * Asks a yes/no question on stderr and reads the answer from stdin.
 *
 * @param question - Prompt
 * @returns True for "y" or "yes"
 */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Builds the `x402` command tree.
 *
 * @param rt - Runtime
 * @returns The CLI
 */
export function buildCli(rt: Runtime) {
  const cli = Cli.create("x402", {
    version: __X402_CLI_VERSION__,
    description: "Pay for x402 resources from the command line",
    update: false,
    sync: false,
  });
  cli.use(walletErrors);
  cli.command(accountCommands(rt));
  balanceCommand(cli as unknown as Cli.Cli, rt);
  payCommand(cli as unknown as Cli.Cli, rt);
  cli.command(configCommands(rt));
  cli.command(policyCommands(rt));
  return cli;
}

/**
 * Runs the CLI with the given defaults.
 *
 * @param defaults - Config defaults; the loaded config file overrides them
 * @param options - Argv and IO overrides
 */
export async function serve(defaults: Config, options: RunOptions = {}): Promise<void> {
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const io: Io = {
    stdout,
    stderr: options.stderr ?? (text => void process.stderr.write(text)),
    isTTY: options.isTTY ?? process.stdin.isTTY === true,
    confirm: options.confirm ?? promptYesNo,
  };
  const rt: Runtime = {
    defaults,
    env: options.env ?? process.env,
    fetch: options.fetch ?? globalThis.fetch,
    io,
  };
  await buildCli(rt).serve(options.argv ?? process.argv.slice(2), {
    stdout,
    env: rt.env,
    ...(options.exit ? { exit: options.exit } : {}),
  });
}
