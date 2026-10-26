import { extname } from "node:path";
import type { Network } from "@x402/core/types";
import { Cli, z } from "incur";
import { parseAllowAsset, parseUsdAmount, writeConfig } from "../config";
import { networksProblem } from "../networks";
import { WalletError, type Config } from "../types";
import { loadSettings, usage, type Runtime } from "./context";
import { configOption, example } from "./options";

/**
 * Builds the `policy` command group.
 *
 * @param rt - Runtime
 * @returns The command group
 */
export function policyCommands(rt: Runtime) {
  const policy = Cli.create("policy", { description: "Manage spend controls and networks" });

  policy.command("set", {
    description: "Update spendControls and networks in the config file",
    options: z.object({
      maxAmount: z
        .string()
        .optional()
        .describe("Per-payment USD cap on default assets, e.g. '$0.50'"),
      allowAsset: z
        .array(z.string())
        .optional()
        .describe(
          "Allow a non-default asset: <network>/<asset>[/<atomic cap>], repeatable. Replaces the list",
        ),
      network: z
        .array(z.string())
        .optional()
        .describe(
          "Network to pay on, most preferred first: CAIP-2 id or pattern such as solana:*. Repeatable. Replaces the list",
        ),
      dryRun: z.boolean().optional().describe("Print the result without writing"),
      config: configOption,
    }),
    examples: [
      example("--max-amount '$0.50'", "Cap each payment at 50 cents"),
      example(
        "--allow-asset eip155:8453/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/2000000",
        "Allow an asset with an atomic cap",
      ),
      example("--network eip155:8453 --network 'solana:*'", "Prefer Base, then any Solana cluster"),
      example("--network eip155:84532", "Pay on Base Sepolia only"),
      example("--max-amount '$5' --dry-run", "Preview without writing"),
    ],
    async run(c) {
      const { maxAmount, allowAsset, network, dryRun } = c.options;
      if (maxAmount === undefined && !allowAsset?.length && !network?.length) {
        usage("Nothing to set.", "x402 policy set --max-amount '$0.50'");
      }
      if (maxAmount !== undefined) parseUsdAmount(maxAmount);
      const networks = network?.length ? ([...new Set(network)] as Network[]) : undefined;
      const problem = networksProblem(networks);
      if (problem) usage(`Invalid --network: ${problem}.`, "x402 policy set --network eip155:8453");
      const { file } = await loadSettings(rt, c.options.config, true);
      if (extname(file.path) !== ".json") {
        throw new WalletError(`Cannot rewrite ${file.path}; edit ${file.path} directly.`);
      }
      const next: Config = { ...file.config };
      if (maxAmount !== undefined || allowAsset?.length) {
        next.spendControls = {
          ...file.config.spendControls,
          ...(maxAmount !== undefined ? { maxAmountPerPayment: maxAmount } : {}),
          ...(allowAsset?.length ? { allowedAssets: allowAsset.map(parseAllowAsset) } : {}),
        };
      }
      if (networks) next.networks = networks;
      if (!dryRun) await writeConfig(file.path, next);
      return {
        path: file.path,
        written: !dryRun,
        ...(next.spendControls ? { spendControls: next.spendControls } : {}),
        ...(next.networks ? { networks: next.networks } : {}),
      };
    },
  });

  return policy;
}
