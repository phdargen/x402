import { x402HTTPClient } from "@x402/core/client";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  PaymentRequirementsV1,
  SettleResponse,
} from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { Cli } from "incur";
import { z } from "incur";
import { createClient } from "../client";
import { capSpendControls } from "../config";
import { describeNetwork, networkLabel, NetworkNotAllowedError, toCaip2 } from "../networks";
import { WalletError, type NetworkFamily } from "../types";
import {
  addNetworkHint,
  loadSettings,
  resolveAccount,
  resolveFamilies,
  resolveNetworks,
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
  yesOption,
  example,
} from "./options";

const DRY_RUN = "x402-cli:dry-run";
const DECLINED = "x402-cli:declined";

interface Quote {
  url: string;
  scheme: string;
  network: Network;
  /** e.g. `"Base Sepolia"`, when a family knows the network. */
  networkName?: string;
  testnet?: boolean;
  asset: string;
  amount: string;
  /** e.g. `"0.01 USDC"`, when the asset is known. */
  formatted?: string;
  payTo: string;
}

/** Keeps the original payload error, which wrapFetchWithPayment rethrows as a plain Error. */
class PayingClient extends x402HTTPClient {
  failure: unknown;

  /**
   * Creates the payload, remembering the error when it fails.
   *
   * @param paymentRequired - The server's 402 response
   * @returns The payment payload
   */
  async createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
    try {
      return await super.createPaymentPayload(paymentRequired);
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }
}

/**
 * Describes the requirement the client is about to pay.
 *
 * @param url - Request URL
 * @param requirement - Selected requirement, after spend controls and network policy
 * @param families - Registered families
 * @returns A quote
 */
function toQuote(
  url: string,
  requirement: PaymentRequirements | PaymentRequirementsV1,
  families: NetworkFamily[],
): Quote {
  const network = toCaip2(families, requirement.network);
  const amount =
    "maxAmountRequired" in requirement ? requirement.maxAmountRequired : requirement.amount;
  const family = families.find(f => networkMatchesPattern(f.network, network));
  const formatted = family?.formatAmount?.(amount, requirement.asset, network);
  const info = describeNetwork(families, network);
  return {
    url,
    scheme: requirement.scheme,
    network,
    ...(info ? { networkName: info.name, testnet: info.testnet } : {}),
    asset: requirement.asset,
    amount,
    ...(formatted ? { formatted } : {}),
    payTo: requirement.payTo,
  };
}

/**
 * Quotes a value for the shell when it contains anything beyond URL-safe characters.
 *
 * @param value - Value
 * @returns The value, single-quoted when needed
 */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Suggests how to pay on the first offered network after the network policy rejected them all.
 *
 * @param url - Request URL
 * @param error - The rejection
 * @param configured - `config.networks`
 * @returns A wallet error with a runnable hint
 */
function withNetworkHint(
  url: string,
  error: NetworkNotAllowedError,
  configured: Network[] | undefined,
): WalletError {
  const [next] = error.offered;
  if (!next) return new WalletError(error.message);
  const hint =
    !configured || configured.some(pattern => networkMatchesPattern(pattern, next))
      ? `x402 pay ${shellQuote(url)} --network ${next}`
      : addNetworkHint(configured, next);
  return new WalletError(error.message, { hint });
}

/**
 * Parses `-H "Name: value"` flags.
 *
 * @param headers - Raw header flags
 * @returns Header tuples
 */
function parseHeaders(headers: string[] = []): [string, string][] {
  return headers.map(header => {
    const index = header.indexOf(":");
    if (index <= 0)
      usage(
        `Invalid header "${header}".`,
        `x402 pay https://api.example.com/paid -H 'Accept: application/json'`,
      );
    return [header.slice(0, index).trim(), header.slice(index + 1).trim()];
  });
}

/**
 * Reads the settlement receipt from a paid response, if any.
 *
 * @param response - Paid response
 * @param client - The paying client
 * @param families - Registered families
 * @returns The settle response with a CAIP-2 network, or undefined when the header is absent
 */
function receiptOf(
  response: Response,
  client: x402HTTPClient,
  families: NetworkFamily[],
): SettleResponse | undefined {
  let receipt: SettleResponse;
  try {
    receipt = client.getPaymentSettleResponse(name => response.headers.get(name));
  } catch {
    return undefined;
  }
  return { ...receipt, network: toCaip2(families, receipt.network) };
}

/**
 * Registers the `pay` command.
 *
 * @param cli - Root CLI
 * @param rt - Runtime
 */
export function payCommand(cli: Cli.Cli, rt: Runtime): void {
  cli.command("pay", {
    description:
      "Request a URL and pay its x402 price. The body goes to stdout, the receipt to stderr",
    args: z.object({ url: z.string().optional().describe("URL to request") }),
    options: z.object({
      method: z.string().optional().describe("HTTP method. Defaults to GET, or POST with --data"),
      header: z.array(z.string()).optional().describe("Request header 'Name: value', repeatable"),
      data: z.string().optional().describe("Request body"),
      maxAmount: z
        .string()
        .optional()
        .describe(
          "Per-payment USD cap for this request. Can lower the configured cap, never raise it",
        ),
      dryRun: z.boolean().optional().describe("Show what would be paid without paying"),
      yes: yesOption,
      network: z
        .array(z.string())
        .optional()
        .describe(
          "CAIP-2 network to pay on, repeatable, most preferred first. Can narrow config.networks, never widen it",
        ),
      rpc: rpcOption,
      account: accountOption,
      family: familiesOption,
      wallet: walletOption,
      config: configOption,
    }),
    alias: { method: "X", header: "H", data: "d" },
    examples: [
      example("https://api.example.com/paid --max-amount '$0.10'", "Pay up to 10 cents"),
      example("https://api.example.com/paid --dry-run", "Show the price without paying"),
      example(
        "https://api.example.com/paid --network eip155:84532",
        "Pay on Base Sepolia. Testnets are off unless selected or configured",
      ),
      example(
        `https://api.example.com/paid -X POST -H 'Content-Type: application/json' -d '{"q":1}' --yes`,
        "POST without a confirmation prompt",
      ),
    ],
    hint: "Without --yes, pay asks for confirmation when stdin is a terminal. Otherwise spend controls are the only gate.",
    async run(c) {
      const { url } = c.args;
      if (!url)
        usage("No URL specified.", "x402 pay https://api.example.com/paid --max-amount '$0.10'");
      const { config } = await loadSettings(rt, c.options.config);
      const name = resolveAccount(c.options.account, rt, config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      const networks = resolveNetworks(c.options.network, config);
      const rpc = resolveRpc(c.options.rpc, rt, config);
      const families = await resolveFamilies(c.options.family, rt, config, wallet, name);
      const client = await createClient({
        wallet,
        families,
        account: name,
        spendControls: capSpendControls(config.spendControls, c.options.maxAmount),
        networks,
        rpc,
      });

      let quote: Quote | undefined;
      client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
        quote = toQuote(url, selectedRequirements, families);
        if (c.options.dryRun) return { abort: true, reason: DRY_RUN };
        if (c.options.yes || !rt.io.isTTY) return;
        const price = quote.formatted ?? `${quote.amount} of ${quote.asset}`;
        const ok = await rt.io.confirm(
          `Pay ${price} to ${quote.payTo} on ${networkLabel(families, quote.network)}? [y/N] `,
        );
        return ok ? undefined : { abort: true, reason: DECLINED };
      });

      const payer = new PayingClient(client);
      const method = c.options.method ?? (c.options.data !== undefined ? "POST" : "GET");
      let response: Response;
      try {
        response = await wrapFetchWithPayment(rt.fetch, payer)(url, {
          method,
          headers: parseHeaders(c.options.header),
          ...(c.options.data !== undefined ? { body: c.options.data } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(DRY_RUN) && quote) return { dryRun: true, ...quote };
        if (message.includes(DECLINED)) throw new WalletError("Payment declined.");
        if (payer.failure instanceof NetworkNotAllowedError) {
          throw withNetworkHint(url, payer.failure, config.networks);
        }
        if (payer.failure instanceof WalletError) throw payer.failure;
        throw error;
      }

      const receipt = receiptOf(response, payer, families);
      const body = await response.text();
      if (c.options.dryRun && !quote) rt.io.stderr("No payment required.\n");
      if (c.formatExplicit) {
        if (!response.ok) throw new WalletError(`HTTP ${response.status}: ${body.slice(0, 500)}`);
        return {
          status: response.status,
          ...(quote ? { quote } : {}),
          ...(receipt ? { receipt } : {}),
          body,
        };
      }
      rt.io.stdout(body.endsWith("\n") || body === "" ? body : `${body}\n`);
      if (receipt?.success) {
        const price = quote?.formatted ?? (quote ? `${quote.amount} of ${quote.asset}` : "");
        rt.io.stderr(
          `Paid ${price} on ${networkLabel(families, receipt.network)}. Transaction: ${receipt.transaction}\n`,
        );
      }
      if (!response.ok) throw new WalletError(`The server responded with HTTP ${response.status}.`);
      return undefined;
    },
  });
}
