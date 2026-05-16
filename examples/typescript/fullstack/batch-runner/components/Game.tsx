"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createInitialState, tick, tryJump } from "@/lib/game/engine";
import type { EngineCallbacks } from "@/lib/game/engine";
import { render } from "@/lib/game/renderer";
import type { GameState } from "@/lib/game/types";
import {
  BANK_PENALTY_MULTIPLIER,
  JUMP_COST_UNITS,
  RECEIVER_ADDRESS,
  SKIP_DEPOSIT,
} from "@/lib/x402/config";
import { signGameVoucher, buildGameChannelConfig } from "@/lib/x402/channel";
import type { SessionInfo } from "./DepositFlow";
import { GameHUD } from "./GameHUD";
import { GameOver } from "./GameOver";

type GameProps = {
  session: SessionInfo;
  onPlayAgain: () => void;
};

export function Game({ session, onPlayAgain }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(createInitialState());
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const balanceRef = useRef(session.depositedBalance);
  const cumulativeRef = useRef(0n);
  const jumpCountRef = useRef(0);
  const bankPenaltyRef = useRef(0);
  const channelIdRef = useRef<`0x${string}` | null>(session.channelId);
  const lastVoucherRef = useRef<{
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    signature: `0x${string}`;
  } | null>(null);

  const [hudState, setHudState] = useState({
    balance: Number(session.depositedBalance),
    distance: 0,
    voucherCount: 0,
    bankPenaltyJumpsLeft: 0,
    jumpCost: Number(JUMP_COST_UNITS),
    isFrozen: false,
  });
  const [gameOver, setGameOver] = useState(false);
  const [rank, setRank] = useState<number | null>(null);
  const [started, setStarted] = useState(false);

  const currentJumpCost = useCallback((): bigint => {
    return bankPenaltyRef.current > 0
      ? JUMP_COST_UNITS * BigInt(BANK_PENALTY_MULTIPLIER)
      : JUMP_COST_UNITS;
  }, []);

  const handleJumpCost = useCallback((): boolean => {
    const cost = currentJumpCost();
    if (balanceRef.current < cost) return false;

    balanceRef.current -= cost;
    cumulativeRef.current += cost;
    jumpCountRef.current++;

    if (bankPenaltyRef.current > 0) {
      bankPenaltyRef.current--;
    }

    const cid = channelIdRef.current;
    if (cid) {
      signGameVoucher(session.voucherSigner, cid, cumulativeRef.current).then(voucher => {
        lastVoucherRef.current = voucher;
      });
    }

    return true;
  }, [session.voucherSigner, currentJumpCost]);

  const endGame = useCallback(() => {
    stateRef.current.phase = "game-over";
    setGameOver(true);
    setHudState(prev => ({ ...prev, balance: Number(balanceRef.current) }));
    cancelAnimationFrame(animRef.current);
  }, []);

  const callbacks = useRef<EngineCallbacks>({
    onJumpCost: () => false,
    onHitGasPump: () => {},
    onHitBank: () => {},
    onGameOver: () => {},
    canvasWidth: 800,
    canvasHeight: 400,
  });

  useEffect(() => {
    callbacks.current = {
      onJumpCost: handleJumpCost,
      onHitGasPump: () => {},
      onHitBank: () => {
        bankPenaltyRef.current = 5;
      },
      onGameOver: endGame,
      canvasWidth: canvasRef.current?.width ?? 800,
      canvasHeight: canvasRef.current?.height ?? 400,
    };
  }, [handleJumpCost, endGame]);

  // Game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resizeCanvas = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      canvas.width = rect.width;
      canvas.height = rect.height;
      callbacks.current.canvasWidth = canvas.width;
      callbacks.current.canvasHeight = canvas.height;
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    const loop = (timestamp: number) => {
      const dt = lastTimeRef.current ? Math.min(timestamp - lastTimeRef.current, 33) : 16;
      lastTimeRef.current = timestamp;

      const state = stateRef.current;

      if (state.phase !== "game-over") {
        tick(state, dt, callbacks.current);

        if (
          balanceRef.current < currentJumpCost() &&
          state.phase === "running" &&
          !state.isJumping
        ) {
          const groundY = canvas.height * 0.78;
          const dinoX = 80;
          for (const obs of state.obstacles) {
            if (obs.passed) continue;
            if (obs.x < dinoX + 30 && obs.x + obs.width > dinoX) {
              const obsTop = groundY - obs.height;
              if (groundY - 48 < obsTop + obs.height) {
                endGame();
                break;
              }
            }
          }
        }

        render(ctx, state);

        if (state.frameCount % 10 === 0) {
          setHudState({
            balance: Number(balanceRef.current),
            distance: state.distance,
            voucherCount: jumpCountRef.current,
            bankPenaltyJumpsLeft: bankPenaltyRef.current,
            jumpCost: Number(currentJumpCost()),
            isFrozen: state.phase === "frozen",
          });
        }
      }

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [currentJumpCost, endGame]);

  // Input handling
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        if (!started) setStarted(true);
        tryJump(stateRef.current, callbacks.current);
      }
    };

    const handleTouch = (e: TouchEvent) => {
      e.preventDefault();
      if (!started) setStarted(true);
      tryJump(stateRef.current, callbacks.current);
    };

    window.addEventListener("keydown", handleKey);
    const canvas = canvasRef.current;
    canvas?.addEventListener("touchstart", handleTouch, { passive: false });

    return () => {
      window.removeEventListener("keydown", handleKey);
      canvas?.removeEventListener("touchstart", handleTouch);
    };
  }, [started]);

  // Compute channelId from session + real receiver address
  useEffect(() => {
    if (session.channelId) {
      channelIdRef.current = session.channelId;
      return;
    }
    if (!SKIP_DEPOSIT) {
      console.error("[batch-runner] Missing channelId from deposit response");
      return;
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(RECEIVER_ADDRESS)) {
      console.error("[batch-runner] Missing NEXT_PUBLIC_RECEIVER_ADDRESS for skip-deposit mode");
      return;
    }

    const receiver = RECEIVER_ADDRESS;
    const receiverAuthorizer = receiver;

    const { channelId } = buildGameChannelConfig(
      session.playerAddress,
      session.sessionAddress,
      receiver,
      receiverAuthorizer,
      session.channelSalt,
    );
    channelIdRef.current = channelId;
  }, [session]);

  const handleSubmitScore = async () => {
    const state = stateRef.current;
    const res = await fetch("/api/leaderboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: session.playerAddress,
        distance: Math.floor(state.distance),
        voucherCount: jumpCountRef.current,
        lastVoucher: lastVoucherRef.current,
        signerAddress: session.sessionAddress,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setRank(data.rank ?? null);
    }
  };

  return (
    <div className="relative w-full h-[400px] rounded-2xl overflow-hidden border border-[var(--color-surface-lighter)]">
      <GameHUD
        balance={hudState.balance}
        distance={hudState.distance}
        voucherCount={hudState.voucherCount}
        bankPenaltyJumpsLeft={hudState.bankPenaltyJumpsLeft}
        jumpCost={hudState.jumpCost}
        isFrozen={hudState.isFrozen}
      />

      <canvas ref={canvasRef} className="w-full h-full block" />

      {!started && !gameOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] z-10">
          <div className="text-center animate-slide-up">
            <p className="text-lg font-bold text-white mb-2">Press SPACE or tap to start</p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Avoid gas pumps (freeze) and banks ({BANK_PENALTY_MULTIPLIER}x cost)
            </p>
          </div>
        </div>
      )}

      {gameOver && (
        <GameOver
          distance={stateRef.current.distance}
          voucherCount={jumpCountRef.current}
          totalSpent={Number(cumulativeRef.current)}
          rank={rank}
          onPlayAgain={onPlayAgain}
          onSubmitScore={handleSubmitScore}
        />
      )}
    </div>
  );
}
