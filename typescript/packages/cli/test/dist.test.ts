import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_USDC, TEST_EVM_ADDRESS, TEST_EVM_KEY, tempDir } from "./helpers";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const CHAIN_PACKAGES = ["@x402/evm", "@x402/svm", "viem", "@solana/kit"];

describe.runIf(existsSync(join(dist, "bin.js")))("built package", () => {
  it("keeps chain packages out of everything but the family entries", () => {
    const files = readdirSync(dist).filter(
      f => f.endsWith(".js") && f !== "evm.js" && f !== "svm.js",
    );
    expect(files).toContain("index.js");
    expect(files).toContain("bin.js");
    for (const file of files) {
      const source = readFileSync(join(dist, file), "utf8");
      for (const name of CHAIN_PACKAGES) {
        expect(source, `${file} imports ${name}`).not.toMatch(new RegExp(`from ["']${name}["/']`));
        expect(source, `${file} imports ${name}`).not.toMatch(
          new RegExp(`import\\(["']${name}["/']`),
        );
      }
    }
  });

  it("keeps incur out of the library entry", () => {
    expect(readFileSync(join(dist, "index.js"), "utf8")).not.toMatch(/from ["']incur["']/);
  });

  describe("x402 pay --dry-run against a 402 fixture", () => {
    let server: Server;
    let url: string;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const header = encodePaymentRequiredHeader({
          x402Version: 2,
          resource: { url: `http://${req.headers.host}${req.url}` },
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: BASE_USDC,
              amount: "10000",
              payTo: TEST_EVM_ADDRESS,
              maxTimeoutSeconds: 60,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        });
        res.writeHead(402, { "PAYMENT-REQUIRED": header, "Content-Type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/paid`;
    });

    afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

    it("prints the quote and exits 0 without paying", async () => {
      const { code, stdout } = await new Promise<{ code: number; stdout: string }>(resolve => {
        execFile(
          process.execPath,
          [join(dist, "bin.js"), "pay", url, "--dry-run", "--json"],
          { env: { PATH: process.env.PATH, HOME: tempDir(), X402_EVM_PRIVATE_KEY: TEST_EVM_KEY } },
          (error, out) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: out }),
        );
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        dryRun: true,
        url,
        scheme: "exact",
        network: "eip155:8453",
        networkName: "Base",
        testnet: false,
        asset: BASE_USDC,
        amount: "10000",
        formatted: "0.01 USDC",
        payTo: TEST_EVM_ADDRESS,
      });
    });
  });
});
