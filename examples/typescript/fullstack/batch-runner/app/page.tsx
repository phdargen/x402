"use client";

import { useEffect, useState } from "react";
import { WalletConnect, type BaseAuthSession } from "@/components/WalletConnect";
import { DepositFlow, type SessionInfo } from "@/components/DepositFlow";
import { Game } from "@/components/Game";
import { Leaderboard } from "@/components/Leaderboard";
import { buildGameChannelConfig } from "@/lib/x402/channel";
import { NEXT_DEV, PLAY_PRICE_UNITS, RECEIVER_ADDRESS } from "@/lib/x402/config";
import { LocalStorageChannelStorage } from "@/lib/x402/browserStorage";
import {
  createStoredSessionKey,
  loadStoredSessionKey,
  signerFromStoredSession,
} from "@/lib/x402/sessionKey";

const DEV_PLAYER_ADDRESS = "0x000000000000000000000000000000000000dead" as const;
const DEV_DELEGATION_SIGNATURE = "0x11" as const;

export default function Home() {
  const [authSession, setAuthSession] = useState<BaseAuthSession | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [gameKey, setGameKey] = useState(0);

  useEffect(() => {
    if (!NEXT_DEV) return;

    setSession(createDevSession());
  }, []);

  const handlePlayAgain = () => {
    if (NEXT_DEV) {
      setSession(createDevSession());
      setGameKey(k => k + 1);
      return;
    }

    setSession(null);
    setGameKey(k => k + 1);
  };

  const handleSignOut = () => {
    setAuthSession(null);
    setSession(null);
  };

  const showWallet = !NEXT_DEV;

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-8 gap-8">
      {/* Header */}
      <header className="w-full max-w-2xl flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-[var(--color-base-blue)]">Batch</span> Runner
          </h1>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            1,000 jumps. $1. Zero gas.
          </p>
        </div>
        {showWallet ? (
          <WalletConnect session={authSession} onSignIn={setAuthSession} onSignOut={handleSignOut} />
        ) : (
          <span className="px-3 py-1.5 text-xs border border-[var(--color-base-blue)] rounded-lg text-[var(--color-base-blue)]">
            NEXT_DEV
          </span>
        )}
      </header>

      {/* Game area */}
      <div className="w-full max-w-2xl">
        {NEXT_DEV && session ? (
          <Game key={gameKey} session={session} onPlayAgain={handlePlayAgain} />
        ) : NEXT_DEV ? (
          <DevLoading />
        ) : !authSession ? (
          <Landing />
        ) : !session ? (
          <DepositFlow authSession={authSession} onSessionReady={setSession} />
        ) : (
          <Game key={gameKey} session={session} onPlayAgain={handlePlayAgain} />
        )}
      </div>

      {/* Leaderboard */}
      <div className="w-full max-w-2xl">
        <Leaderboard />
      </div>

      {/* Footer */}
      <footer className="text-xs text-[var(--color-text-secondary)] text-center pb-4">
        Built with{" "}
        <a href="https://x402.org" className="text-[var(--color-base-blue)] hover:underline">
          x402
        </a>{" "}
        batch-settlement on Base Sepolia
      </footer>
    </main>
  );
}

function createDevSession(): SessionInfo {
  const stored =
    loadStoredSessionKey(DEV_PLAYER_ADDRESS) ??
    createStoredSessionKey(DEV_PLAYER_ADDRESS, DEV_DELEGATION_SIGNATURE);
  const { voucherSigner } = signerFromStoredSession(stored);
  const { config, channelId } = buildGameChannelConfig(
    stored.playerAddress,
    stored.sessionAddress,
    RECEIVER_ADDRESS,
    RECEIVER_ADDRESS,
    stored.channelSalt,
  );

  return {
    channelSalt: stored.channelSalt,
    sessionAddress: stored.sessionAddress,
    voucherSigner,
    playerAddress: stored.playerAddress,
    channelId,
    channelConfig: config,
    channelBalance: PLAY_PRICE_UNITS,
    chargedCumulativeAmount: 0n,
    roundBudget: PLAY_PRICE_UNITS,
    storage: new LocalStorageChannelStorage(),
  };
}

function DevLoading() {
  return (
    <div className="animate-slide-up flex flex-col items-center gap-3 py-16 text-sm text-[var(--color-text-secondary)]">
      Starting local gameplay session...
    </div>
  );
}

function Landing() {
  return (
    <div className="animate-slide-up flex flex-col items-center gap-6 py-16">
      <div className="text-6xl">🤖</div>
      <h2 className="text-3xl font-bold text-center">
        <span className="text-[var(--color-base-blue)]">Batch</span> Runner
      </h2>
      <p className="text-sm text-[var(--color-text-secondary)] text-center max-w-sm leading-relaxed">
        A Chrome-dino-style game powered by x402 batch-settlement. Deposit $0.01 per play, each jump
        costs $0.001 via a signed voucher. No gas fees, no wallet popups during gameplay.
      </p>
      <div className="grid grid-cols-3 gap-6 text-center text-xs mt-2">
        <div>
          <div className="text-2xl mb-1">💰</div>
          <div className="text-[var(--color-text-secondary)]">$0.001 per jump</div>
        </div>
        <div>
          <div className="text-2xl mb-1">⚡</div>
          <div className="text-[var(--color-text-secondary)]">~0.1ms signing</div>
        </div>
        <div>
          <div className="text-2xl mb-1">🔒</div>
          <div className="text-[var(--color-text-secondary)]">Session keys</div>
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-secondary)] mt-4">
        Sign in with Base to start playing
      </p>
    </div>
  );
}
