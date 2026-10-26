import { x402Client, type SchemeRegistration, type SpendControls } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { networkPolicy, networksProblem, rpcUrlsProblem } from "./networks";
import { WalletError, type NetworkFamily, type RpcUrls, type Wallet } from "./types";

export interface CreateClientOptions {
  wallet: Wallet;
  families: NetworkFamily[];
  /** Account name. Defaults to `"default"`. */
  account?: string;
  spendControls?: SpendControls;
  /**
   * Networks to pay on, most preferred first: CAIP-2 ids or patterns such as `"solana:*"`.
   * Unset allows every network except known testnets.
   */
  networks?: Network[];
  rpc?: RpcUrls;
}

/**
 * Builds an x402Client that signs with `wallet` on every family.
 *
 * @param options - Wallet, families, and optional account, spend controls, networks, and RPC overrides
 * @returns A configured x402Client
 */
export async function createClient(options: CreateClientOptions): Promise<x402Client> {
  const { wallet, families, account = "default", networks, rpc = {} } = options;
  const problem = networksProblem(networks) ?? rpcUrlsProblem(rpc);
  if (problem) throw new WalletError(problem);
  const schemes: SchemeRegistration[] = [];
  for (const family of families) {
    schemes.push(...family.schemes(await wallet.getSigner(account, family), rpc));
  }
  return x402Client.fromConfig({
    schemes,
    spendControls: options.spendControls,
    policies: [networkPolicy(families, networks)],
  });
}
