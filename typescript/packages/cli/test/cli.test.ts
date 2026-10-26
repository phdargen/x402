import { describe, expect, it } from "vitest";
import {
  fakeFamily,
  fakeRequirement,
  minimalWallet,
  paidServer,
  run,
  TEST_EVM_KEY,
} from "./helpers";

const COMMANDS = [
  ["account", "create"],
  ["account", "list"],
  ["account", "view"],
  ["account", "default"],
  ["account", "export"],
  ["account", "delete"],
  ["balance"],
  ["pay"],
  ["config", "init"],
  ["config", "view"],
  ["policy", "set"],
];

describe("help", () => {
  it.each(COMMANDS.map(c => [c.join(" "), c]))("%s --help lists Examples", async (_, command) => {
    const result = await run([...command, "--help"]);
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toMatch(new RegExp(`x402 ${command.join(" ")}`));
  });

  it("prints top-level help with no arguments", async () => {
    const result = await run([]);
    expect(result.stdout).toContain("Usage: x402 <command>");
  });
});

describe("missing input fails fast with a runnable example", () => {
  it("pay without a URL", async () => {
    const result = await run(["pay"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("No URL specified.");
    expect(result.stdout).toContain("x402 pay https://api.example.com/paid --max-amount '$0.10'");
  });

  it("account create without --family", async () => {
    const result = await run(["account", "create"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("No family specified.");
    expect(result.stdout).toContain("x402 account create --family evm");
  });

  it("commands with no resolvable family", async () => {
    const result = await run(["balance"]);
    expect(result.stdout).toContain("x402 account create --family evm");
  });

  it("export and delete without --yes off a TTY", async () => {
    const result = await run(["account", "delete", "--family", "evm", "--wallet", "keychain"]);
    expect(result.stdout).toContain("needs --yes when stdin is not a terminal");
    expect(result.stdout).toContain("--yes");
  });

  it("an invalid account name", async () => {
    const result = await run(["balance", "--account", "../etc"]);
    expect(result.stdout).toContain("Invalid account name");
  });
});

describe("pay confirmation", () => {
  const defaults = { wallet: minimalWallet(), families: [fakeFamily()] };

  it("asks in a TTY and aborts when declined", async () => {
    const questions: string[] = [];
    const { fetch, requests } = paidServer([fakeRequirement()]);
    const result = await run(["pay", "https://example.com/paid"], {
      defaults,
      fetch,
      isTTY: true,
      confirm: async question => (questions.push(question), false),
    });
    expect(questions).toEqual(["Pay 0.01 TOK to merchant on Fake? [y/N] "]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Payment declined.");
    expect(requests).toHaveLength(1);
  });

  it("skips the prompt with --yes and off a TTY", async () => {
    for (const options of [
      { argv: ["--yes"], isTTY: true },
      { argv: [], isTTY: false },
    ]) {
      const { fetch } = paidServer([fakeRequirement()]);
      const result = await run(["pay", "https://example.com/paid", ...options.argv], {
        defaults,
        fetch,
        isTTY: options.isTTY,
        confirm: async () => {
          throw new Error("should not prompt");
        },
      });
      expect(result.stdout).toBe("paid content\n");
    }
  });

  it("sends method, headers, and body", async () => {
    const { fetch, requests } = paidServer([fakeRequirement()]);
    await run(["pay", "https://example.com/paid", "-H", "X-Test: 1", "-d", '{"a":1}', "--yes"], {
      defaults,
      fetch,
    });
    expect(requests[1].method).toBe("POST");
    expect(requests[1].headers.get("x-test")).toBe("1");
    expect(await requests[1].text()).toBe('{"a":1}');
  });
});

describe("secrets", () => {
  it("never appear on stderr or in errors", async () => {
    const env = { X402_EVM_PRIVATE_KEY: TEST_EVM_KEY };
    const results = await Promise.all([
      run(["account", "create", "--family", "evm"], { env }),
      run(["account", "export", "--family", "evm", "--yes"], { env }),
      run(["account", "view", "--family", "evm", "--account", "work"], { env }),
    ]);
    for (const result of results) expect(result.stderr).not.toContain(TEST_EVM_KEY.slice(2));
    expect(results[2].stdout).not.toContain(TEST_EVM_KEY.slice(2));
  });
});
