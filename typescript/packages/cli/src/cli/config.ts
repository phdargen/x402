import { extname } from "node:path";
import { Cli, z } from "incur";
import { redactUrl, writeConfig } from "../config";
import { WalletError, type Config } from "../types";
import { loadSettings, resolveWallet, type Runtime } from "./context";
import { configOption, familiesOption, walletOption, example } from "./options";

/**
 * Replaces wallet and family instances with their ids and redacts RPC URLs, which often
 * embed API keys, so the config can be printed.
 *
 * @param config - Merged config
 * @returns A JSON-safe view of the config
 */
function printable(config: Config): Record<string, unknown> {
  const view: Record<string, unknown> = { ...config };
  if (typeof config.wallet === "object") view.wallet = config.wallet.id;
  if (config.wallets) view.wallets = config.wallets.map(wallet => wallet.id);
  if (config.families) view.families = config.families.map(f => (typeof f === "string" ? f : f.id));
  if (config.rpc) {
    view.rpc = Object.fromEntries(
      Object.entries(config.rpc).map(([network, url]) => [network, redactUrl(url ?? "")]),
    );
  }
  return view;
}

/**
 * Builds the `config` command group.
 *
 * @param rt - Runtime
 * @returns The command group
 */
export function configCommands(rt: Runtime) {
  const config = Cli.create("config", { description: "Create and inspect the config file" });

  config.command("init", {
    description: "Write a starter config file",
    options: z.object({
      family: familiesOption,
      wallet: walletOption,
      force: z.boolean().optional().describe("Overwrite an existing file"),
      config: configOption,
    }),
    examples: [
      example("--family evm", "EVM only, local wallet"),
      example("--family evm --family svm --wallet keychain", "Both families in the keychain"),
    ],
    async run(c) {
      const { file, config: merged } = await loadSettings(rt, c.options.config, true);
      if (file.exists && !c.options.force) {
        throw new WalletError(`${file.path} already exists.`, { hint: "x402 config init --force" });
      }
      if (extname(file.path) !== ".json") {
        throw new WalletError(`Cannot write ${file.path}; edit ${file.path} directly.`);
      }
      const next: Config = {};
      if (c.options.wallet) next.wallet = resolveWallet(c.options.wallet, rt, merged).id;
      if (c.options.family?.length) next.families = [...new Set(c.options.family)];
      next.spendControls = { maxAmountPerPayment: "$1" };
      await writeConfig(file.path, next);
      return { path: file.path, config: next };
    },
  });

  config.command("view", {
    description: "Print the resolved config and the file it came from",
    options: z.object({ config: configOption }),
    examples: [example("", "Show the resolved config"), example("--json", "As JSON")],
    async run(c) {
      const { file, config: merged } = await loadSettings(rt, c.options.config);
      return {
        path: file.path,
        source: file.source,
        exists: file.exists,
        config: printable(merged),
      };
    },
  });

  return config;
}
