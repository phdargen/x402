import { WalletError, type NetworkFamily } from "./types";

export interface FamilyLoader {
  load: () => Promise<NetworkFamily>;
  /** Packages to install, space separated. */
  install: string;
}

const BUILT_IN: Record<string, FamilyLoader> = {
  evm: { load: () => import("@x402/cli/evm").then(m => m.evm()), install: "@x402/evm viem" },
  svm: {
    load: () => import("@x402/cli/svm").then(m => m.svm()),
    install: "@x402/svm @solana/kit",
  },
};

/**
 * Returns whether an import failure means one of `packages` is not installed.
 *
 * @param error - The import error
 * @param packages - Package names the loader depends on
 * @returns True when the error is a missing-module error for one of them
 */
function isMissingPeer(error: unknown, packages: string[]): boolean {
  if (
    !(error instanceof Error) ||
    (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND"
  ) {
    return false;
  }
  return packages.some(
    name => error.message.includes(`'${name}`) || error.message.includes(`"${name}`),
  );
}

/**
 * Loads a built-in network family by id.
 *
 * @param id - Family id, e.g. `"evm"`
 * @param table - Loader table, overridable for tests
 * @returns The family
 * @throws WalletError when the id is unknown or its peer packages are missing
 */
export async function loadFamily(
  id: string,
  table: Record<string, FamilyLoader> = BUILT_IN,
): Promise<NetworkFamily> {
  const loader = table[id];
  if (!loader) {
    throw new WalletError(
      `Unknown family "${id}". Known families: ${Object.keys(table).join(", ")}.`,
    );
  }
  try {
    return await loader.load();
  } catch (error) {
    if (isMissingPeer(error, loader.install.split(" "))) {
      throw new WalletError(`${id.toUpperCase()} support is not installed.`, {
        hint: `npm i ${loader.install}`,
      });
    }
    throw error;
  }
}
