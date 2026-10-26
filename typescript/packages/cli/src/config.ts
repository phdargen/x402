import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_MAX_AMOUNT_PER_PAYMENT,
  type SpendControlAsset,
  type SpendControls,
} from "@x402/core/client";
import type { Money, Network } from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { isNetworkId, networksProblem, rpcUrlsProblem } from "./networks";
import { WalletError, type Config, type RpcUrls } from "./types";

export type ConfigSource = "--config" | "X402_CONFIG" | "home";

export interface LoadedConfig {
  config: Config;
  path: string;
  source: ConfigSource;
  exists: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * Path of the per-user config file.
 *
 * @param env - Environment
 * @returns `$XDG_CONFIG_HOME/x402/config.json`, defaulting to `~/.config/x402/config.json`
 */
function homeConfigPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "x402", "config.json");
}

/**
 * Picks the config file: `--config`, then `X402_CONFIG`, then the home file. The working
 * directory is never searched, so a cloned repo cannot change spend controls or RPCs.
 *
 * @param flag - Value of `--config`
 * @param env - Environment
 * @returns The chosen path and where it came from
 */
function resolveConfigPath(
  flag: string | undefined,
  env: Env,
): { path: string; source: ConfigSource } {
  if (flag) return { path: resolve(flag), source: "--config" };
  if (env.X402_CONFIG?.trim())
    return { path: resolve(env.X402_CONFIG.trim()), source: "X402_CONFIG" };
  return { path: homeConfigPath(env), source: "home" };
}

/**
 * Throws a config validation error.
 *
 * @param path - Config file
 * @param message - What is wrong
 */
function invalid(path: string, message: string): never {
  throw new WalletError(`Invalid config ${path}: ${message}`);
}

/**
 * Validates spend controls from a config file.
 *
 * @param value - Raw value
 * @param path - Config file, for errors
 * @returns The spend controls
 */
function parseSpendControls(value: unknown, path: string): SpendControls {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "spendControls must be an object; spend controls cannot be turned off");
  }
  const raw = value as Record<string, unknown>;
  const controls: SpendControls = {};
  if (raw.maxAmountPerPayment !== undefined) {
    if (
      typeof raw.maxAmountPerPayment !== "string" &&
      typeof raw.maxAmountPerPayment !== "number"
    ) {
      invalid(path, 'spendControls.maxAmountPerPayment must be a dollar amount such as "$1"');
    }
    parseUsdAmount(raw.maxAmountPerPayment);
    controls.maxAmountPerPayment = raw.maxAmountPerPayment;
  }
  if (raw.allowedAssets !== undefined) {
    if (raw.allowedAssets === true) {
      controls.allowedAssets = true;
    } else if (Array.isArray(raw.allowedAssets)) {
      controls.allowedAssets = raw.allowedAssets.map((entry, index) => {
        const item = entry as Partial<SpendControlAsset>;
        if (typeof item?.network !== "string" || typeof item.asset !== "string") {
          invalid(path, `spendControls.allowedAssets[${index}] needs network and asset strings`);
        }
        if (
          item.maxAmountPerPayment !== undefined &&
          !/^\d+$/.test(String(item.maxAmountPerPayment))
        ) {
          invalid(path, `spendControls.allowedAssets[${index}].maxAmountPerPayment must be atomic`);
        }
        return item as SpendControlAsset;
      });
    } else {
      invalid(path, "spendControls.allowedAssets must be true or a list");
    }
  }
  return controls;
}

/**
 * Validates the `networks` and `rpc` fields of any config file.
 *
 * @param config - Config to check
 * @param path - Config file, for errors
 */
function checkNetworkFields(config: Config, path: string): void {
  const problem = networksProblem(config.networks) ?? rpcUrlsProblem(config.rpc);
  if (problem) invalid(path, problem);
}

/**
 * Validates a JSON config. JSON can only name wallets and families by id.
 *
 * @param value - Parsed JSON
 * @param path - Config file, for errors
 * @returns The config
 */
export function parseConfig(value: unknown, path: string): Config {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "expected a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const known = new Set([
    "$schema",
    "account",
    "wallet",
    "families",
    "spendControls",
    "networks",
    "rpc",
  ]);
  const unknown = Object.keys(raw).filter(key => !known.has(key));
  if (unknown.length > 0) invalid(path, `unknown field ${unknown.map(k => `"${k}"`).join(", ")}`);

  const config: Config = {};
  if (raw.account !== undefined) {
    if (typeof raw.account !== "string") invalid(path, "account must be a string");
    config.account = raw.account;
  }
  if (raw.wallet !== undefined) {
    if (typeof raw.wallet !== "string") invalid(path, "wallet must be a wallet id");
    config.wallet = raw.wallet;
  }
  if (raw.families !== undefined) {
    if (!Array.isArray(raw.families) || raw.families.some(f => typeof f !== "string")) {
      invalid(path, "families must be a list of family ids");
    }
    config.families = raw.families as string[];
  }
  if (raw.spendControls !== undefined)
    config.spendControls = parseSpendControls(raw.spendControls, path);
  if (raw.networks !== undefined) config.networks = raw.networks as Config["networks"];
  if (raw.rpc !== undefined) config.rpc = raw.rpc as Config["rpc"];
  checkNetworkFields(config, path);
  return config;
}

/**
 * Loads the resolved config file. Missing explicit paths fail; a missing home file is empty.
 *
 * @param flag - Value of `--config`
 * @param env - Environment
 * @param options - Options
 * @param options.allowMissing - Treat a missing explicit file as empty, for commands that create it
 * @returns The config, its path, and its source
 */
export async function loadConfig(
  flag: string | undefined,
  env: Env,
  options: { allowMissing?: boolean } = {},
): Promise<LoadedConfig> {
  const { path, source } = resolveConfigPath(flag, env);
  if (!existsSync(path)) {
    if (source !== "home" && !options.allowMissing) {
      throw new WalletError(`Config file ${path} (from ${source}) does not exist.`);
    }
    return { config: {}, path, source, exists: false };
  }
  const extension = extname(path);
  if (extension === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      invalid(path, error instanceof Error ? error.message : String(error));
    }
    return { config: parseConfig(parsed, path), path, source, exists: true };
  }
  if (extension === ".ts" || extension === ".mjs" || extension === ".js") {
    const module = (await import(pathToFileURL(path).href)) as { default?: Config };
    if (typeof module.default !== "object" || module.default === null) {
      invalid(path, "expected a default export, e.g. export default defineConfig({ ... })");
    }
    checkNetworkFields(module.default, path);
    return { config: module.default, path, source, exists: true };
  }
  throw new WalletError(`Unsupported config file ${path}. Use .json, .ts, or .mjs.`);
}

/**
 * Applies a loaded config over `runCli` defaults field by field. `wallets` lists are concatenated.
 *
 * @param defaults - Defaults passed to `runCli`
 * @param file - Config loaded from disk
 * @returns The merged config
 */
export function mergeConfig(defaults: Config, file: Config): Config {
  const merged: Config = { ...defaults, ...file };
  const wallets = [...(defaults.wallets ?? []), ...(file.wallets ?? [])];
  if (wallets.length > 0) merged.wallets = wallets;
  return merged;
}

/**
 * Writes a JSON config, refusing other formats.
 *
 * @param path - Destination
 * @param config - Config to write
 */
export async function writeConfig(path: string, config: Config): Promise<void> {
  if (extname(path) !== ".json") {
    throw new WalletError(`Cannot rewrite ${path}; edit ${path} directly.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Parses a plain USD amount into an 18-decimal integer for comparisons.
 *
 * @param money - Amount such as `"$0.10"` or `0.1`
 * @returns Scaled integer
 */
export function parseUsdAmount(money: Money): bigint {
  let parsed: { amount: string; symbol?: string };
  try {
    parsed = parseMoney(money);
  } catch {
    throw new WalletError(
      `Invalid amount ${JSON.stringify(money)}. Use a dollar amount such as '$0.10'.`,
    );
  }
  if (parsed.symbol || parsed.amount.startsWith("-")) {
    throw new WalletError(
      `Invalid amount ${JSON.stringify(money)}. Use a dollar amount such as '$0.10'.`,
    );
  }
  return BigInt(convertToTokenAmount(parsed.amount, 18));
}

/**
 * Lowers the per-payment USD cap to `maxAmount` when it is below the configured cap.
 * `maxAmount` can never raise the cap.
 *
 * @param controls - Configured spend controls
 * @param maxAmount - Value of `--max-amount`
 * @returns The effective spend controls
 */
export function capSpendControls(controls: SpendControls = {}, maxAmount?: Money): SpendControls {
  if (maxAmount === undefined) return controls;
  const configured = controls.maxAmountPerPayment ?? DEFAULT_MAX_AMOUNT_PER_PAYMENT;
  if (configured !== false && parseUsdAmount(maxAmount) >= parseUsdAmount(configured))
    return controls;
  return { ...controls, maxAmountPerPayment: maxAmount };
}

/**
 * Parses an `--allow-asset` value: `<network>/<asset>[/<atomic max per payment>]`.
 *
 * @param spec - Flag value
 * @returns The allowed-asset entry
 */
export function parseAllowAsset(spec: string): SpendControlAsset {
  const [network, asset, max, ...rest] = spec.split("/");
  if (
    !network?.includes(":") ||
    !asset ||
    rest.length > 0 ||
    (max !== undefined && !/^\d+$/.test(max))
  ) {
    throw new WalletError(`Invalid --allow-asset "${spec}".`, {
      hint: "x402 policy set --allow-asset eip155:8453/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/2000000",
    });
  }
  return max === undefined
    ? { network: network as Network, asset }
    : { network: network as Network, asset, maxAmountPerPayment: max };
}

/**
 * Parses `<network>=<url>` RPC overrides from `--rpc` or `X402_RPC`. Errors never echo the
 * value, which may embed an API key.
 *
 * @param specs - Entries
 * @param source - `--rpc` or `X402_RPC`, for errors
 * @returns RPC overrides by network
 */
export function parseRpcSpecs(specs: string[], source: "--rpc" | "X402_RPC"): RpcUrls {
  const hint =
    source === "--rpc"
      ? "x402 balance --rpc eip155:8453=https://mainnet.base.org"
      : "export X402_RPC=eip155:8453=https://mainnet.base.org,eip155:84532=https://sepolia.base.org";
  const rpc: RpcUrls = {};
  for (const spec of specs) {
    const index = spec.indexOf("=");
    const network = spec.slice(0, Math.max(index, 0));
    if (!isNetworkId(network)) {
      throw new WalletError(
        `Invalid ${source} entry. Use <network>=<url> with a CAIP-2 network such as eip155:8453.`,
        { hint },
      );
    }
    const entry = { [network]: spec.slice(index + 1) };
    const problem = rpcUrlsProblem(entry);
    if (problem) throw new WalletError(`Invalid ${source} entry: ${problem}.`, { hint });
    Object.assign(rpc, entry);
  }
  return rpc;
}

/**
 * Hides everything after the origin of a URL that could carry a credential.
 *
 * @param url - RPC URL
 * @returns The origin, plus `/<redacted>` when the URL has a path, query, fragment, or user info
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "<redacted>";
  }
  const hidden =
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash;
  return hidden ? `${parsed.origin}/<redacted>` : parsed.origin;
}
