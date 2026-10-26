import { networkMatchesPattern } from "@x402/core/utils";
import type { Cli } from "incur";
import { z } from "incur";
import { describeNetwork } from "../networks";
import {
  checkNetworkFlags,
  loadSettings,
  resolveAccount,
  resolveFamilies,
  resolveRpc,
  resolveWallet,
  usage,
  type Runtime,
} from "./context";
import {
  accountOption,
  configOption,
  familiesOption,
  rpcOption,
  walletOption,
  example,
} from "./options";

/**
 * Registers the `balance` command.
 *
 * @param cli - Root CLI
 * @param rt - Runtime
 */
export function balanceCommand(cli: Cli.Cli, rt: Runtime): void {
  cli.command("balance", {
    description: "Show default-asset balances for an account",
    options: z.object({
      account: accountOption,
      network: z
        .array(z.string())
        .optional()
        .describe("CAIP-2 network, repeatable. Defaults to each family's main and test networks"),
      rpc: rpcOption,
      family: familiesOption,
      wallet: walletOption,
      config: configOption,
    }),
    examples: [
      example("", "Balances for the default account"),
      example("--network eip155:8453", "Base mainnet only"),
      example(
        "--network eip155:84532 --rpc eip155:84532=https://sepolia.base.org",
        "Base Sepolia through a specific RPC",
      ),
      example("--account work --wallet keychain", "A keychain account"),
    ],
    async run(c) {
      const { config } = await loadSettings(rt, c.options.config);
      const name = resolveAccount(c.options.account, rt, config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      const networks = checkNetworkFlags(c.options.network, "x402 balance --network eip155:8453");
      const rpc = resolveRpc(c.options.rpc, rt, config);
      let families = await resolveFamilies(c.options.family, rt, config, wallet, name);
      if (networks) {
        families = families.filter(f => networks.some(n => networkMatchesPattern(f.network, n)));
        if (families.length === 0) {
          usage(
            `No family of this account pays on ${networks.join(", ")}.`,
            "x402 balance --network eip155:8453",
          );
        }
      }
      const balances = await Promise.all(
        families.map(async family => {
          const { address } = await wallet.getSigner(name, family);
          const rows = await family.balances(address, rpc, networks);
          return rows.map(row => {
            const info = describeNetwork(families, row.network);
            return {
              family: family.id,
              address,
              ...row,
              ...(info ? { networkName: info.name, testnet: info.testnet } : {}),
            };
          });
        }),
      );
      return { account: name, wallet: wallet.id, balances: balances.flat() };
    },
  });
}
