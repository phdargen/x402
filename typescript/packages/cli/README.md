# @x402/cli

The `x402` command-line client, plus a small library for adding wallets. Pay for x402-protected URLs from a terminal, a script, or an agent, with per-payment spend controls that the CLI cannot turn off.

## Install

`@x402/cli` ships the binary, config, and wallets. Chain support is opt-in: install the peers for the families you use.

| You pay on   | Install                                                |
| ------------ | ------------------------------------------------------ |
| EVM          | `npm i -g @x402/cli @x402/evm viem`                    |
| Solana (SVM) | `npm i -g @x402/cli @x402/svm @solana/kit`             |
| Both         | `npm i -g @x402/cli @x402/evm viem @x402/svm @solana/kit` |

Requires Node.js 22 or later. The package is ESM-only.

## First run

Create an account. The default `local` wallet reads keys from environment variables, so `create` prints the new key instead of storing it:

```sh
x402 account create --family evm
```

Export the printed variable, or have the CLI append it to an env file (created with mode 0600):

```sh
export X402_EVM_PRIVATE_KEY=0x...
# or
x402 account create --family evm --write-env ~/.x402.env
```

Fund the address with USDC, then check it:

```sh
x402 balance
```

Pay for a resource. The response body goes to stdout and the receipt to stderr:

```sh
x402 pay https://api.example.com/paid --dry-run          # show the price only
x402 pay https://api.example.com/paid --max-amount '$0.10'
```

In a terminal, `pay` asks for confirmation unless you pass `--yes`. When stdin is not a terminal it never prompts, so spend controls are the only gate.

To keep keys in the OS keychain (macOS Keychain or Linux Secret Service through `secret-tool`) instead of environment variables:

```sh
x402 account create --family evm --account work --wallet keychain
x402 pay https://api.example.com/paid --account work --wallet keychain
```

Every command accepts `--json` and lists examples in `--help`.

## Commands

| Command | Purpose |
| --- | --- |
| `x402 account create --family <id>` | Create an account, or show it if it exists |
| `x402 account list` | List the wallet's accounts |
| `x402 account view` | Show an account's addresses |
| `x402 account default <name>` | Set `account` in the config file |
| `x402 account export --family <id> --yes` | Print a private key to stdout |
| `x402 account delete --family <id> --yes` | Delete a key from the wallet |
| `x402 balance [--network <caip2>] [--rpc <network>=<url>]` | Default-asset balances |
| `x402 pay <url> [-X] [-H] [-d] [--max-amount] [--network] [--rpc] [--dry-run] [--yes]` | Request and pay |
| `x402 config init` / `x402 config view` | Create or print the config file |
| `x402 policy set [--max-amount] [--allow-asset] [--network]` | Update spend controls and networks |

## Resolution

- **Account:** `--account`, then `X402_ACCOUNT`, then `config.account`, then `default`.
- **Wallet:** `--wallet`, then `X402_WALLET`, then `config.wallet`, then `local`.
- **Families:** `--family` (repeatable), then `config.families`, then the families the wallet reports for the account.
- **Networks:** `pay --network` (repeatable), then `config.networks`, then every network except testnets. See [Networks](#networks).
- **RPC URLs:** per network, `--rpc`, then `X402_RPC`, then `config.rpc`, then the chain's public RPC.
- **Config file:** `--config <path>`, then `X402_CONFIG`, then `~/.config/x402/config.json`. The first one found wins. The working directory is never searched, so a cloned repository cannot raise spend caps or swap RPCs.

```json
{
  "account": "work",
  "wallet": "keychain",
  "families": ["evm"],
  "spendControls": { "maxAmountPerPayment": "$1" },
  "networks": ["eip155:8453", "solana:*"],
  "rpc": { "eip155:8453": "https://base.example-rpc.com" }
}
```

`pay --max-amount` can lower the configured cap for one request but never raise it.

## Networks

When a server offers several payment options, `pay` drops the ones the account cannot sign for or that break spend controls. It then applies `networks` and pays the first option left.

- **`networks` is an ordered allowlist.** Entries are CAIP-2 ids (`eip155:8453`) or patterns (`solana:*`). Options on other networks are dropped, and the rest are tried in list order. Within one entry, the server's order is kept, so `["eip155:8453", "solana:*"]` means "Base first, then any Solana cluster".
- **Without `networks`, testnets are off.** Every network except a known testnet is allowed, in the server's order. A server that lists Base Sepolia before Base gets paid on Base. Families mark testnets: viem's chain table for EVM, and devnet and testnet for Solana.
- **`pay --network` selects networks for one request.** It takes CAIP-2 ids, most preferred first. It can narrow `networks` but never widen it. Without `networks`, it can select any network, testnets included.

```sh
x402 pay https://api.example.com/paid --network eip155:84532   # pay on Base Sepolia once
x402 policy set --network eip155:84532                          # testnet only, from now on
x402 policy set --network eip155:8453 --network 'solana:*'      # prefer Base, then Solana
```

When no option is left, the error lists the networks the server offered and a command that would pay on the first of them. The confirmation prompt, `--dry-run`, and `balance` show network names and mark testnets, for example `Base Sepolia (testnet)`.

x402 v1 servers name networks differently (`base-sepolia`). The CLI pays them too, and still takes and reports CAIP-2 ids only.

## RPC URLs

Set an RPC URL per CAIP-2 network in `config.rpc`, in `X402_RPC` as comma-separated `<network>=<url>` pairs, or with a repeatable `--rpc <network>=<url>` on `pay` and `balance`:

```sh
export X402_RPC=eip155:8453=https://mainnet.base.org,eip155:84532=https://sepolia.base.org
x402 balance --rpc eip155:84532=https://base-sepolia.example-rpc.com
```

Keys must be concrete network ids; patterns such as `eip155:*` are rejected. `config view` prints only the origin of URLs with a path or query, because RPC providers often put an API key there. Error messages never echo an RPC URL.

## Write a wallet

A wallet only has to return a signer. Optional methods (`list`, `create`, `delete`, `exportKey`) enable the matching commands; when one is missing, the CLI says the wallet does not support that command.

```ts
import { runCli, WalletError, type Wallet } from "@x402/cli";
import { evm } from "@x402/cli/evm";

export function cdp(): Wallet {
  return {
    id: "cdp",
    async getSigner(name, family) {
      if (family.id === "evm") return getCdpEvmSigner(name); // your code
      throw new WalletError(`cdp has no ${family.id} support`);
    },
  };
}

await runCli({ wallet: cdp(), families: [evm()] }); // optional: ship your own bin
```

Throw `WalletError(message, { hint })` for failures; the CLI prints the hint as the next command to run. Keep secrets out of messages.

The same wallet works without the CLI:

```ts
import { createClient } from "@x402/cli";
import { evm } from "@x402/cli/evm";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = await createClient({ wallet: cdp(), families: [evm()], account: "work" });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

Or list it in a TypeScript config so `--wallet cdp` selects it:

```ts
// ~/.config/x402/config.ts, loaded with --config or X402_CONFIG
import { defineConfig } from "@x402/cli";

export default defineConfig({ wallets: [cdp()] });
```
