"use client";

import { useState } from "react";
import { useConnection } from "wagmi";
import { WalletConnect } from "@/components/WalletConnect";
import { DepositFlow, type SessionInfo } from "@/components/DepositFlow";
import { Game } from "@/components/Game";
import { Leaderboard } from "@/components/Leaderboard";

export default function Home() {
  const { isConnected } = useConnection();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [gameKey, setGameKey] = useState(0);

  const handlePlayAgain = () => {
    setSession(null);
    setGameKey((k) => k + 1);
  };

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
        <WalletConnect />
      </header>

      {/* Game area */}
      <div className="w-full max-w-2xl">
        {!isConnected ? (
          <Landing />
        ) : !session ? (
          <DepositFlow onSessionReady={setSession} />
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

function Landing() {
  return (
    <div className="animate-slide-up flex flex-col items-center gap-6 py-16">
      <div className="text-6xl">🤖</div>
      <h2 className="text-3xl font-bold text-center">
        <span className="text-[var(--color-base-blue)]">Batch</span> Runner
      </h2>
      <p className="text-sm text-[var(--color-text-secondary)] text-center max-w-sm leading-relaxed">
        A Chrome-dino-style game powered by x402 batch-settlement.
        Deposit $1 USDC, each jump costs $0.001 via a signed voucher.
        No gas fees, no wallet popups during gameplay.
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
        Connect your wallet to start playing
      </p>
    </div>
  );
}
