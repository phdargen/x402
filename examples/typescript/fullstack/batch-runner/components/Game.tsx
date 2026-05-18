"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createInitialState, tick, tryJump } from "@/lib/game/engine";
import type { EngineCallbacks } from "@/lib/game/engine";
import { render } from "@/lib/game/renderer";
import type { GameState } from "@/lib/game/types";
import {
  BANK_PENALTY_MULTIPLIER,
  JUMP_COST_UNITS,
  NEXT_DEV,
  PLAY_PRICE_UNITS,
  VOUCHER_CHECKPOINT_JUMPS,
} from "@/lib/x402/config";
import { signGameVoucher, verifyGameVoucher } from "@/lib/x402/channel";
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

  const balanceRef = useRef(
    session.roundBudget < PLAY_PRICE_UNITS ? session.roundBudget : PLAY_PRICE_UNITS,
  );
  const cumulativeRef = useRef(session.chargedCumulativeAmount);
  const roundSpentRef = useRef(0n);
  const jumpCountRef = useRef(0);
  const bankPenaltyRef = useRef(0);
  const channelIdRef = useRef<`0x${string}` | null>(session.channelId);
  const checkpointInFlightRef = useRef<Promise<void> | null>(null);
  const jumpPaymentInFlightRef = useRef(false);
  const jumpQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastVoucherRef = useRef<{
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    signature: `0x${string}`;
  } | null>(null);

  const [hudState, setHudState] = useState({
    balance: Number(balanceRef.current),
    distance: 0,
    voucherCount: 0,
    bankPenaltyJumpsLeft: 0,
    gasLockoutMs: 0,
  });
  const [gameOver, setGameOver] = useState(false);
  const [rank, setRank] = useState<number | null>(null);
  const [started, setStarted] = useState(false);

  const currentJumpCost = useCallback((): bigint => {
    return bankPenaltyRef.current > 0
      ? JUMP_COST_UNITS * BigInt(BANK_PENALTY_MULTIPLIER)
      : JUMP_COST_UNITS;
  }, []);

  const flushVoucherCheckpoint = useCallback(
    (keepalive = false): Promise<void> => {
      if (NEXT_DEV) return Promise.resolve();

      const cid = channelIdRef.current;
      const voucher = lastVoucherRef.current;
      if (!cid || !voucher || !session.channelConfig) return Promise.resolve();

      const body = JSON.stringify({
        channelConfig: session.channelConfig,
        voucher,
        jumpCount: jumpCountRef.current,
        distance: Math.floor(stateRef.current.distance),
        roundSpent: roundSpentRef.current.toString(),
      });

      const checkpoint = fetch("/api/game/voucher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive,
      }).then(response => {
        if (!response.ok) {
          throw new Error(`Voucher checkpoint failed (${response.status})`);
        }
      });

      const tracked = checkpoint
        .catch(err => {
          console.error("[batch-runner] Voucher checkpoint error:", err);
        })
        .finally(() => {
          if (checkpointInFlightRef.current === tracked) {
            checkpointInFlightRef.current = null;
          }
        });
      checkpointInFlightRef.current = tracked;

      return checkpointInFlightRef.current;
    },
    [session.channelConfig],
  );

  const handleJumpCost = useCallback(async (): Promise<boolean> => {
    if (jumpPaymentInFlightRef.current) return false;

    const cost = currentJumpCost();
    if (balanceRef.current < cost) return false;

    const cid = channelIdRef.current;
    if (!cid || !session.channelConfig) return false;

    jumpPaymentInFlightRef.current = true;
    let voucher: {
      channelId: `0x${string}`;
      maxClaimableAmount: string;
      signature: `0x${string}`;
    };
    const nextCumulative = cumulativeRef.current + cost;
    try {
      voucher = await signGameVoucher(session.voucherSigner, cid, nextCumulative);
      const validVoucher = await verifyGameVoucher(session.sessionAddress, voucher);
      if (!validVoucher) return false;
    } catch (err) {
      console.error("[batch-runner] Voucher signing error:", err);
      return false;
    } finally {
      jumpPaymentInFlightRef.current = false;
    }

    balanceRef.current -= cost;
    cumulativeRef.current = nextCumulative;
    roundSpentRef.current += cost;
    jumpCountRef.current++;

    if (bankPenaltyRef.current > 0) {
      bankPenaltyRef.current--;
    }

    lastVoucherRef.current = voucher;
    void session.storage.set(cid, {
      balance: session.channelBalance.toString(),
      chargedCumulativeAmount: cumulativeRef.current.toString(),
      signedMaxClaimable: cumulativeRef.current.toString(),
      signature: voucher.signature,
    });

    if (jumpCountRef.current % VOUCHER_CHECKPOINT_JUMPS === 0) {
      void flushVoucherCheckpoint();
    }

    return true;
  }, [
    currentJumpCost,
    flushVoucherCheckpoint,
    session.channelBalance,
    session.channelConfig,
    session.sessionAddress,
    session.storage,
    session.voucherSigner,
  ]);

  const endGame = useCallback(() => {
    stateRef.current.phase = "game-over";
    setGameOver(true);
    setHudState(prev => ({ ...prev, balance: Number(balanceRef.current) }));
    cancelAnimationFrame(animRef.current);
    void flushVoucherCheckpoint(true);
  }, [flushVoucherCheckpoint]);

  const waitForJumpCooldown = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      const wait = () => {
        const state = stateRef.current;
        if (state.phase === "game-over" || state.phase === "falling" || state.jumpCooldownMs <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(wait);
      };
      wait();
    });
  }, []);

  const requestJump = useCallback(() => {
    if (!started) setStarted(true);

    const queuedJump = jumpQueueRef.current
      .catch(() => {})
      .then(async () => {
        await waitForJumpCooldown();
        await tryJump(stateRef.current, callbacks.current);
      });

    jumpQueueRef.current = queuedJump.then(() => undefined);
    void jumpQueueRef.current;
  }, [started, waitForJumpCooldown]);

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

        render(ctx, state);

        if (state.frameCount % 10 === 0) {
          setHudState({
            balance: Number(balanceRef.current),
            distance: state.distance,
            voucherCount: jumpCountRef.current,
            bankPenaltyJumpsLeft: bankPenaltyRef.current,
            gasLockoutMs: state.jumpLockoutMs,
          });
        }
      }

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resizeCanvas);
      void flushVoucherCheckpoint(true);
    };
  }, [currentJumpCost, endGame, flushVoucherCheckpoint]);

  // Input handling
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        requestJump();
      }
    };

    const handleTouch = (e: TouchEvent) => {
      e.preventDefault();
      requestJump();
    };

    const handlePageHide = () => {
      void flushVoucherCheckpoint(true);
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("pagehide", handlePageHide);
    const canvas = canvasRef.current;
    canvas?.addEventListener("touchstart", handleTouch, { passive: false });

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("pagehide", handlePageHide);
      canvas?.removeEventListener("touchstart", handleTouch);
    };
  }, [flushVoucherCheckpoint, requestJump]);

  const handleSubmitScore = async () => {
    const state = stateRef.current;
    await flushVoucherCheckpoint();
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
        gasLockoutMs={hudState.gasLockoutMs}
      />

      <canvas ref={canvasRef} className="w-full h-full block" />

      {!started && !gameOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] z-10">
          <div className="text-center animate-slide-up">
            <p className="text-lg font-bold text-white mb-2">Press SPACE or tap to start</p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              Chain paid jumps over gaps. Gas disables in-flight chains; banks make{" "}
              {BANK_PENALTY_MULTIPLIER}x jumps.
            </p>
          </div>
        </div>
      )}

      {gameOver && (
        <GameOver
          distance={stateRef.current.distance}
          voucherCount={jumpCountRef.current}
          totalSpent={Number(roundSpentRef.current)}
          rank={rank}
          onPlayAgain={onPlayAgain}
          onSubmitScore={handleSubmitScore}
        />
      )}
    </div>
  );
}
