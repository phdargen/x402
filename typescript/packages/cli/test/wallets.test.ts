import { beforeEach, describe, expect, it, vi } from "vitest";
import { keychain, local } from "../src";
import { fakeFamily, run, TEST_EVM_ADDRESS, TEST_EVM_KEY } from "./helpers";

type Callback = (error: (Error & { code?: number | string }) | null, stdout: string) => void;

const store = new Map<string, string>();
const calls: { command: string; args: string[]; input: string }[] = [];
let missingBinary = false;

/**
 * Simulates `security` and `secret-tool` against an in-memory store.
 *
 * @param command - Binary
 * @param args - Arguments
 * @param input - Stdin
 * @returns Exit code and stdout
 */
function simulate(
  command: string,
  args: string[],
  input: string,
): { code: number; stdout: string } {
  const arg = (flag: string, from = args) => from[from.indexOf(flag) + 1];
  if (command === "security") {
    if (args[0] === "-i") {
      const tokens = input.trim().split(/\s+/);
      store.set(arg("-a", tokens), arg("-w", tokens));
      return { code: 0, stdout: "" };
    }
    if (args[0] === "find-generic-password") {
      const value = store.get(arg("-a"));
      return value ? { code: 0, stdout: `${value}\n` } : { code: 44, stdout: "" };
    }
    if (args[0] === "delete-generic-password") {
      return store.delete(arg("-a")) ? { code: 0, stdout: "" } : { code: 44, stdout: "" };
    }
    const dump = [...store.keys()]
      .map(
        account =>
          `keychain: "/login.keychain-db"\n    "acct"<blob>="${account}"\n    "svce"<blob>="x402"\n`,
      )
      .join("");
    return {
      code: 0,
      stdout: `${dump}keychain: "/x"\n    "acct"<blob>="other"\n    "svce"<blob>="other"\n`,
    };
  }
  const account = arg("account");
  if (args[0] === "store") store.set(account, input);
  if (args[0] === "lookup")
    return store.has(account) ? { code: 0, stdout: store.get(account)! } : { code: 1, stdout: "" };
  if (args[0] === "clear") store.delete(account);
  if (args[0] === "search") {
    const out = [...store].map(
      ([a, s]) =>
        `[/x/${a}]\nlabel = x402 ${a}\nsecret = ${s}\nattribute.account = ${a}\nattribute.service = x402\n`,
    );
    return { code: 0, stdout: out.join("") };
  }
  return { code: 0, stdout: "" };
}

vi.mock("node:child_process", () => ({
  execFile: (command: string, args: string[], _options: unknown, callback: Callback) => ({
    stdin: {
      end(input: string) {
        calls.push({ command, args, input });
        queueMicrotask(() => {
          if (missingBinary) {
            return callback(
              Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }),
              "",
            );
          }
          const { code, stdout } = simulate(command, args, input);
          callback(code === 0 ? null : Object.assign(new Error("failed"), { code }), stdout);
        });
      },
    },
  }),
}));

beforeEach(() => {
  store.clear();
  calls.length = 0;
  missingBinary = false;
});

describe("local wallet", () => {
  it("prints the export hint when the variable is missing", async () => {
    const result = await run(["account", "view", "--family", "evm"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("No evm key for the local wallet.");
    expect(result.stdout).toContain("export X402_EVM_PRIVATE_KEY=<private key>");
  });

  it("returns created: false when the variable is already set, twice", async () => {
    const env = { X402_EVM_PRIVATE_KEY: TEST_EVM_KEY };
    for (let i = 0; i < 2; i++) {
      const result = await run(["account", "create", "--family", "evm", "--json"], { env });
      expect(result.json).toEqual({
        account: "default",
        family: "evm",
        wallet: "local",
        address: TEST_EVM_ADDRESS,
        created: false,
      });
    }
  });

  it("returns a new key in env, and lists accounts from the environment", async () => {
    const wallet = local({ env: { X402_FAKE_PRIVATE_KEY: "abc", X402_EMPTY_PRIVATE_KEY: " " } });
    expect(await wallet.list!()).toEqual([{ name: "default", family: "fake" }]);
    const created = await local({ env: {} }).create!("default", fakeFamily());
    expect(created).toEqual({
      address: "addr-fakesecret",
      created: true,
      env: { X402_FAKE_PRIVATE_KEY: "fakesecret" },
    });
    expect(local().delete).toBeUndefined();
    expect(local().exportKey).toBeUndefined();
  });

  it("only holds the default account", async () => {
    await expect(local({ env: {} }).getSigner("work", fakeFamily())).rejects.toThrow(
      'named "default"',
    );
  });
});

describe.each(["darwin", "linux"] as const)("keychain wallet on %s", platform => {
  it("round-trips create, get, list, export, and delete", async () => {
    const wallet = keychain({ platform });
    const family = fakeFamily();
    expect(await wallet.create!("work", family)).toEqual({
      address: "addr-fakesecret",
      created: true,
    });
    expect(await wallet.create!("work", family)).toEqual({
      address: "addr-fakesecret",
      created: false,
    });
    expect((await wallet.getSigner("work", family)).address).toBe("addr-fakesecret");
    expect(await wallet.list!()).toEqual([{ name: "work", family: "fake" }]);
    expect(await wallet.exportKey!("work", family)).toBe("fakesecret");
    await wallet.delete!("work", family);
    await wallet.delete!("work", family);
    expect(await wallet.list!()).toEqual([]);
    await expect(wallet.getSigner("work", family)).rejects.toThrow(
      'No fake account "work" in the keychain.',
    );
  });

  it("never passes the secret in argv", async () => {
    await keychain({ platform }).create!("work", fakeFamily());
    expect(calls.some(call => call.args.some(arg => arg.includes("fakesecret")))).toBe(false);
  });
});

describe("keychain wallet errors", () => {
  it("asks for secret-tool when it is missing on Linux", async () => {
    missingBinary = true;
    const error = await keychain({ platform: "linux" }).list!().catch(e => e);
    expect(error.message).toBe("The keychain wallet on Linux needs secret-tool.");
    expect(error.hint).toContain("libsecret-tools");
  });

  it("fails on unsupported platforms without a plaintext fallback", async () => {
    await expect(keychain({ platform: "win32" }).list!()).rejects.toThrow(
      "supports macOS and Linux",
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses entries that could inject security -i arguments", async () => {
    const family = {
      ...fakeFamily(),
      keys: { ...fakeFamily().keys, generate: async () => "a -w b" },
    };
    await expect(keychain({ platform: "darwin" }).create!("work", family)).rejects.toThrow(
      "alphanumeric",
    );
  });
});
