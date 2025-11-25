import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "api/x402-handler": "src/api/x402-handler.ts",
  },
  dts: {
    resolve: true,
  },
  sourcemap: true,
  target: "node16",
  external: ["next"],
};

export default defineConfig([
  {
    ...baseConfig,
    format: "esm",
    outDir: "dist/esm",
    clean: true,
  },
  {
    ...baseConfig,
    format: "cjs",
    outDir: "dist/cjs",
    clean: false,
  },
]);
