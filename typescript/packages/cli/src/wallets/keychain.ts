import { execFile } from "node:child_process";
import { WalletError, type AccountEntry, type NetworkFamily, type Wallet } from "../types";
import { keyWallet } from "./keys";

const SERVICE = "x402";
const TIMEOUT_MS = 10_000;
const MAC_NOT_FOUND = 44;

interface ExecResult {
  code: number;
  stdout: string;
  missingBinary: boolean;
}

/**
 * Runs a command, optionally feeding `input` on stdin so secrets stay out of argv.
 *
 * @param command - Binary
 * @param args - Arguments
 * @param input - Data written to stdin
 * @returns Exit code and stdout
 */
function run(command: string, args: string[], input?: string): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout: TIMEOUT_MS }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({
        code,
        stdout: String(stdout ?? "").trim(),
        missingBinary: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
      });
    });
    child.stdin?.end(input ?? "");
  });
}

/**
 * Keychain entry name for an account.
 *
 * @param name - Account name
 * @param family - Family
 * @returns `<name>:<family>`
 */
function entryName(name: string, family: NetworkFamily): string {
  return `${name}:${family.id}`;
}

/**
 * Parses `<name>:<family>` entries.
 *
 * @param entries - Raw entry names
 * @returns Account entries, skipping malformed ones
 */
function toAccounts(entries: string[]): AccountEntry[] {
  return entries.flatMap(entry => {
    const index = entry.lastIndexOf(":");
    return index > 0 ? [{ name: entry.slice(0, index), family: entry.slice(index + 1) }] : [];
  });
}

/**
 * Throws a WalletError for a failed keychain command. Never includes command output.
 *
 * @param action - What was attempted
 * @param result - The failed result
 */
function fail(action: string, result: ExecResult): never {
  if (result.missingBinary) {
    throw new WalletError("The keychain wallet on Linux needs secret-tool.", {
      hint: "sudo apt install libsecret-tools   # Debian/Ubuntu; other distros ship it as libsecret",
    });
  }
  throw new WalletError(`Keychain ${action} failed (exit code ${result.code}).`);
}

const mac = {
  async get(account: string) {
    const result = await run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
    ]);
    if (result.code === MAC_NOT_FOUND) return undefined;
    if (result.code !== 0) fail("read", result);
    return result.stdout || undefined;
  },
  async put(account: string, secret: string) {
    if (!/^[a-z0-9][a-z0-9-]*:[a-z0-9]+$/.test(account) || !/^[A-Za-z0-9]+$/.test(secret)) {
      throw new WalletError(
        "Keychain entries need a lowercase account name and an alphanumeric key.",
      );
    }
    const command = `add-generic-password -U -s ${SERVICE} -a ${account} -l "${SERVICE} ${account}" -w ${secret}\n`;
    const result = await run("security", ["-i"], command);
    if (result.code !== 0) fail("write", result);
  },
  async remove(account: string) {
    const result = await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    if (result.code !== 0 && result.code !== MAC_NOT_FOUND) fail("delete", result);
  },
  async list() {
    const result = await run("security", ["dump-keychain"]);
    if (result.code !== 0) fail("list", result);
    return result.stdout.split("keychain:").flatMap(block => {
      const service = /"svce"<blob>="([^"]*)"/.exec(block)?.[1];
      const account = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
      return service === SERVICE && account ? [account] : [];
    });
  },
};

const linux = {
  async get(account: string) {
    const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", account]);
    if (result.missingBinary) fail("read", result);
    return result.code === 0 ? result.stdout || undefined : undefined;
  },
  async put(account: string, secret: string) {
    const args = [
      "store",
      "--label",
      `${SERVICE} ${account}`,
      "service",
      SERVICE,
      "account",
      account,
    ];
    const result = await run("secret-tool", args, secret);
    if (result.code !== 0) fail("write", result);
  },
  async remove(account: string) {
    const result = await run("secret-tool", ["clear", "service", SERVICE, "account", account]);
    if (result.missingBinary) fail("delete", result);
  },
  async list() {
    const result = await run("secret-tool", ["search", "--all", "service", SERVICE]);
    if (result.missingBinary) fail("list", result);
    if (result.code !== 0) return [];
    return [...result.stdout.matchAll(/^attribute\.account = (.+)$/gm)].map(match =>
      match[1].trim(),
    );
  },
};

/**
 * Picks the backend for the platform.
 *
 * @param platform - Node platform
 * @returns The backend
 */
function backendFor(platform: NodeJS.Platform): typeof mac {
  if (platform === "darwin") return mac;
  if (platform === "linux") return linux;
  throw new WalletError(`The keychain wallet supports macOS and Linux, not ${platform}.`, {
    hint: "export X402_EVM_PRIVATE_KEY=<private key>   # use the local wallet instead",
  });
}

/**
 * Wallet backed by the macOS Keychain (`security`) or Linux Secret Service (`secret-tool`).
 * Entries use service `x402` and account `<name>:<family>`. There is no plaintext fallback.
 *
 * @param options - Options
 * @param options.platform - Platform override, defaults to `process.platform`
 * @returns The keychain wallet
 */
export function keychain(options: { platform?: NodeJS.Platform } = {}): Wallet {
  const backend = () => backendFor(options.platform ?? process.platform);
  return keyWallet("keychain", {
    exportable: true,
    get: (name, family) => backend().get(entryName(name, family)),
    async put(name, family, secret) {
      const account = entryName(name, family);
      await backend().put(account, secret);
      if ((await backend().get(account)) !== secret) {
        throw new WalletError("The keychain did not store the key.");
      }
    },
    remove: (name, family) => backend().remove(entryName(name, family)),
    missing(name, family) {
      return new WalletError(`No ${family.id} account "${name}" in the keychain.`, {
        hint: `x402 account create --family ${family.id} --account ${name} --wallet keychain`,
      });
    },
    async list() {
      return toAccounts(await backend().list());
    },
  });
}
