import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Cli, z } from "incur";
import { writeConfig } from "../config";
import type { NetworkFamily } from "../types";
import {
  checkAccountName,
  confirmOrFail,
  familyById,
  loadSettings,
  resolveAccount,
  resolveFamilies,
  resolveWallet,
  unsupported,
  usage,
  type Runtime,
} from "./context";
import {
  accountOption,
  configOption,
  familiesOption,
  familyOption,
  walletOption,
  yesOption,
  example,
} from "./options";

/**
 * Appends variables to an env file, creating it with mode 0600 and skipping ones already present.
 *
 * @param path - Env file
 * @param env - Variables
 * @returns Names that were written
 */
async function writeEnvFile(path: string, env: Record<string, string>): Promise<string[]> {
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const present = new Set(
    (existing ?? "").split("\n").map(line => /^(?:export\s+)?([A-Z0-9_]+)=/.exec(line)?.[1]),
  );
  const names = Object.keys(env).filter(name => !present.has(name));
  const lines = names.map(name => `${name}=${env[name]}\n`).join("");
  if (existing === undefined) {
    await writeFile(path, lines, { mode: 0o600 });
  } else if (lines) {
    await appendFile(path, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${lines}`);
  }
  return names;
}

/**
 * Requires `--family` and loads it.
 *
 * @param family - Value of `--family`
 * @param example - Runnable example for the error
 * @param config - Merged config
 * @returns The family
 */
async function requireFamily(
  family: string | undefined,
  example: string,
  config: Parameters<typeof familyById>[1],
): Promise<NetworkFamily> {
  if (!family) usage("No family specified.", example);
  return familyById(family, config);
}

/**
 * Builds the `account` command group.
 *
 * @param rt - Runtime
 * @returns The command group
 */
export function accountCommands(rt: Runtime) {
  const account = Cli.create("account", {
    description: "Create, list, export, and delete accounts",
  });

  account.command("create", {
    description: "Create an account, or show it if it already exists",
    options: z.object({
      family: familyOption,
      account: accountOption,
      wallet: walletOption,
      writeEnv: z
        .string()
        .optional()
        .describe(
          "Local wallet only: append the new key to this env file (mode 0600) instead of printing it",
        ),
      config: configOption,
    }),
    examples: [
      example("--family evm", "Create the default EVM account in the local wallet"),
      example("--family evm --write-env .env", "Write the new key to .env instead of stdout"),
      example(
        "--family svm --account work --wallet keychain",
        "Create a named SVM account in the OS keychain",
      ),
    ],
    async run(c) {
      const { config } = await loadSettings(rt, c.options.config);
      const name = resolveAccount(c.options.account, rt, config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      const family = await requireFamily(
        c.options.family,
        "x402 account create --family evm",
        config,
      );
      if (!wallet.create) {
        unsupported(
          wallet,
          "account create",
          `x402 account create --family ${family.id} --wallet keychain`,
        );
      }
      const result = await wallet.create(name, family);
      const data = {
        account: name,
        family: family.id,
        wallet: wallet.id,
        address: result.address,
        created: result.created,
      };
      if (!result.env) return data;
      if (c.options.writeEnv) {
        const written = await writeEnvFile(c.options.writeEnv, result.env);
        return { ...data, envFile: c.options.writeEnv, written };
      }
      rt.io.stderr("Set this variable to use the account (or rerun with --write-env <file>):\n");
      return { ...data, env: result.env };
    },
  });

  account.command("list", {
    description: "List the wallet's accounts",
    options: z.object({ wallet: walletOption, config: configOption }),
    examples: [
      example("", "List accounts in the resolved wallet"),
      example("--wallet keychain", "List keychain accounts"),
    ],
    async run(c) {
      const { config } = await loadSettings(rt, c.options.config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      if (!wallet.list) unsupported(wallet, "account list", "x402 account list --wallet keychain");
      const defaultAccount = resolveAccount(undefined, rt, config);
      const accounts = await Promise.all(
        (await wallet.list()).map(async entry => {
          try {
            const family = await familyById(entry.family, config);
            const { address } = await wallet.getSigner(entry.name, family);
            return { ...entry, address, default: entry.name === defaultAccount };
          } catch {
            return { ...entry, default: entry.name === defaultAccount };
          }
        }),
      );
      return { wallet: wallet.id, accounts };
    },
  });

  account.command("view", {
    description: "Show an account's addresses",
    options: z.object({
      account: accountOption,
      family: familiesOption,
      wallet: walletOption,
      config: configOption,
    }),
    examples: [
      example("", "Show the default account"),
      example(
        "--account work --family evm --wallet keychain",
        "Show one family of a named account",
      ),
    ],
    async run(c) {
      const { config } = await loadSettings(rt, c.options.config);
      const name = resolveAccount(c.options.account, rt, config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      const families = await resolveFamilies(c.options.family, rt, config, wallet, name);
      const addresses = await Promise.all(
        families.map(async family => ({
          family: family.id,
          address: (await wallet.getSigner(name, family)).address,
        })),
      );
      return { account: name, wallet: wallet.id, addresses };
    },
  });

  account.command("default", {
    description: "Set config.account in the config file",
    args: z.object({ name: z.string().optional().describe("Account name") }),
    options: z.object({ config: configOption }),
    examples: [example("work", "Use the work account by default")],
    async run(c) {
      if (!c.args.name) usage("No account name specified.", "x402 account default work");
      const name = checkAccountName(c.args.name);
      const { file } = await loadSettings(rt, c.options.config, true);
      await writeConfig(file.path, { ...file.config, account: name });
      return { account: name, path: file.path };
    },
  });

  account.command("export", {
    description: "Print an account's private key to stdout",
    options: z.object({
      family: familyOption,
      account: accountOption,
      wallet: walletOption,
      yes: yesOption,
      config: configOption,
    }),
    examples: [
      example(
        "--family evm --wallet keychain --yes",
        "Export the default EVM key from the keychain",
      ),
      example("--family svm --account work --wallet keychain --yes", "Export a named SVM key"),
    ],
    async run(c) {
      const { config } = await loadSettings(rt, c.options.config);
      const name = resolveAccount(c.options.account, rt, config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      const family = await requireFamily(
        c.options.family,
        "x402 account export --family evm --yes",
        config,
      );
      const example = `x402 account export --family ${family.id} --account ${name} --wallet keychain --yes`;
      if (!wallet.exportKey) unsupported(wallet, "account export", example);
      await confirmOrFail(
        rt,
        c.options.yes,
        `Print the ${family.id} private key for "${name}" to stdout? [y/N] `,
        `x402 account export --family ${family.id} --account ${name} --wallet ${wallet.id} --yes`,
      );
      const privateKey = await wallet.exportKey(name, family);
      if (c.formatExplicit) return { account: name, family: family.id, privateKey };
      rt.io.stdout(`${privateKey}\n`);
      return undefined;
    },
  });

  account.command("delete", {
    description: "Delete an account's key from the wallet",
    destructive: true,
    options: z.object({
      family: familyOption,
      account: accountOption,
      wallet: walletOption,
      yes: yesOption,
      config: configOption,
    }),
    examples: [
      example(
        "--family evm --account work --wallet keychain --yes",
        "Delete a keychain EVM account",
      ),
    ],
    async run(c) {
      const { config } = await loadSettings(rt, c.options.config);
      const name = resolveAccount(c.options.account, rt, config);
      const wallet = resolveWallet(c.options.wallet, rt, config);
      const family = await requireFamily(
        c.options.family,
        "x402 account delete --family evm --wallet keychain --yes",
        config,
      );
      const example = `x402 account delete --family ${family.id} --account ${name} --wallet keychain --yes`;
      if (!wallet.delete) unsupported(wallet, "account delete", example);
      await confirmOrFail(
        rt,
        c.options.yes,
        `Delete the ${family.id} key for "${name}" from the ${wallet.id} wallet? [y/N] `,
        `x402 account delete --family ${family.id} --account ${name} --wallet ${wallet.id} --yes`,
      );
      await wallet.delete(name, family);
      return { account: name, family: family.id, wallet: wallet.id, deleted: true };
    },
  });

  return account;
}
