"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { createWalletClient, custom, getAddress, type WalletClient } from "viem";
import { baseSepolia } from "viem/chains";

import { CHAIN_ID } from "@/lib/x402/config";

const AUTH_STORAGE_KEY = "x402:batch-runner:base-auth";

export type BaseAuthSession = {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
  walletClient: WalletClient;
};

type StoredBaseAuthSession = Omit<BaseAuthSession, "walletClient">;

type WalletConnectProps = {
  session: BaseAuthSession | null;
  onSignIn: (session: BaseAuthSession) => void;
  onSignOut: () => void;
};

const SignInWithBaseButton = dynamic(
  () => import("@base-org/account-ui/react").then(mod => mod.SignInWithBaseButton),
  { ssr: false },
);

export function WalletConnect({ session, onSignIn, onSignOut }: WalletConnectProps) {
  const [status, setStatus] = useState<"idle" | "restoring" | "signing">("restoring");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    restoreAuthSession()
      .then(restored => {
        if (cancelled) return;
        if (restored) {
          onSignIn(restored);
        }
      })
      .catch(() => clearStoredAuthSession())
      .finally(() => {
        if (!cancelled) setStatus("idle");
      });

    return () => {
      cancelled = true;
    };
  }, [onSignIn]);

  const handleSignIn = async () => {
    if (status === "signing") return;

    setStatus("signing");
    setError(null);

    try {
      const provider = await getBaseProvider();
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
      });

      const nonce = crypto.randomUUID().replace(/-/g, "");
      const result = (await provider.request({
        method: "wallet_connect",
        params: [
          {
            version: "1",
            capabilities: {
              signInWithEthereum: {
                nonce,
                chainId: `0x${CHAIN_ID.toString(16)}`,
              },
            },
          },
        ],
      })) as {
        accounts: Array<{
          address: `0x${string}`;
          capabilities: {
            signInWithEthereum: {
              message: string;
              signature: `0x${string}`;
            };
          };
        }>;
      };

      const account = result.accounts[0];
      if (!account) {
        throw new Error("Base Account did not return an account");
      }

      const nextSession = buildAuthSession(
        {
          address: getAddress(account.address) as `0x${string}`,
          message: account.capabilities.signInWithEthereum.message,
          signature: account.capabilities.signInWithEthereum.signature,
        },
        provider,
      );

      saveStoredAuthSession(nextSession);
      onSignIn(nextSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in with Base");
    } finally {
      setStatus("idle");
    }
  };

  if (session) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-[var(--color-text-secondary)] font-mono">
          {session.address.slice(0, 6)}...{session.address.slice(-4)}
        </span>
        <button
          onClick={() => {
            clearStoredAuthSession();
            onSignOut();
          }}
          className="px-3 py-1.5 text-xs border border-[var(--color-text-secondary)] rounded-lg
                     hover:border-[var(--color-accent-red)] hover:text-[var(--color-accent-red)]
                     transition-colors cursor-pointer"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <SignInWithBaseButton align="center" colorScheme="dark" onClick={handleSignIn} />
      {status === "restoring" && (
        <div className="text-xs text-[var(--color-text-secondary)]">Restoring session...</div>
      )}
      {status === "signing" && (
        <div className="text-xs text-[var(--color-text-secondary)]">Signing in...</div>
      )}
      {error && <div className="text-xs text-[var(--color-accent-red)] max-w-xs">{error}</div>}
    </div>
  );
}

async function getBaseProvider() {
  const { createBaseAccountSDK } = await import("@base-org/account");
  return createBaseAccountSDK({
    appName: "Batch Runner",
    appChainIds: [CHAIN_ID],
  }).getProvider();
}

function buildAuthSession(
  stored: StoredBaseAuthSession,
  provider: Awaited<ReturnType<typeof getBaseProvider>>,
): BaseAuthSession {
  const address = getAddress(stored.address) as `0x${string}`;
  const walletClient = createWalletClient({
    account: address,
    chain: baseSepolia,
    transport: custom(provider),
  });

  return {
    address,
    message: stored.message,
    signature: stored.signature,
    walletClient,
  };
}

function loadStoredAuthSession(): StoredBaseAuthSession | null {
  if (typeof window === "undefined") return null;

  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as StoredBaseAuthSession;
    if (!stored.address?.startsWith("0x") || !stored.signature?.startsWith("0x")) {
      return null;
    }
    return {
      address: getAddress(stored.address) as `0x${string}`,
      message: stored.message,
      signature: stored.signature,
    };
  } catch {
    return null;
  }
}

function saveStoredAuthSession(session: BaseAuthSession): void {
  if (typeof window === "undefined") return;

  const stored: StoredBaseAuthSession = {
    address: session.address,
    message: session.message,
    signature: session.signature,
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(stored));
}

function clearStoredAuthSession(): void {
  if (typeof window === "undefined") return;

  localStorage.removeItem(AUTH_STORAGE_KEY);
}

async function restoreAuthSession(): Promise<BaseAuthSession | null> {
  const stored = loadStoredAuthSession();
  if (!stored) return null;

  const provider = await getBaseProvider();
  const accounts = (await provider.request({ method: "eth_accounts" })) as `0x${string}`[];
  const hasAccount = accounts.some(account => getAddress(account) === getAddress(stored.address));
  if (!hasAccount) return null;

  return buildAuthSession(stored, provider);
}
