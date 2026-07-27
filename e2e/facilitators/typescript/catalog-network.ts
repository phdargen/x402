import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate e2e/config (harness-injected or walk up from this file). */
function catalogDir(): string {
  const injected = process.env.E2E_MECHANISMS_CATALOG;
  if (injected && existsSync(join(injected, "mechanisms_global.json"))) {
    return injected;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "config");
    if (existsSync(join(candidate, "mechanisms_global.json"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate e2e/config/mechanisms_global.json");
    }
    dir = parent;
  }
}

/** Catalog testnet CAIP-2 for a network id. */
export function catalogTestnetCaip2(networkId: string): string {
  const path = join(catalogDir(), `mechanisms_${networkId}.json`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as {
    testnet: { caip2: string };
  };
  return data.testnet.caip2;
}

/** Prefer `${ID}_NETWORK`, else catalog testnet CAIP-2. */
export function resolveNetworkCaip2(networkId: string): string {
  const fromEnv = process.env[`${networkId.toUpperCase()}_NETWORK`];
  return fromEnv || catalogTestnetCaip2(networkId);
}
