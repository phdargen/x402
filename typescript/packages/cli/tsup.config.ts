import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

const libraryEntries = {
  index: "src/index.ts",
  evm: "src/families/evm.ts",
  svm: "src/families/svm.ts",
};

export default defineConfig({
  entry: { ...libraryEntries, bin: "src/bin.ts" },
  format: "esm",
  outDir: "dist",
  clean: true,
  dts: {
    entry: libraryEntries,
    resolve: true,
  },
  sourcemap: true,
  target: "node22",
  external: [
    "@x402/cli",
    "@x402/cli/evm",
    "@x402/cli/svm",
    "@x402/evm",
    "@x402/svm",
    "viem",
    "@solana/kit",
  ],
  define: { __X402_CLI_VERSION__: JSON.stringify(version) },
});
