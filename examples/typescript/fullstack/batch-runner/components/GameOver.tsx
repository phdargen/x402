"use client";

import { useState } from "react";

type GameOverProps = {
  distance: number;
  voucherCount: number;
  totalSpent: number;
  rank: number | null;
  onPlayAgain: () => void;
  onSubmitScore: () => Promise<void>;
};

export function GameOver({
  distance,
  voucherCount,
  totalSpent,
  rank,
  onPlayAgain,
  onSubmitScore,
}: GameOverProps) {
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const distanceFormatted = Math.floor(distance).toLocaleString();
  const spentFormatted = (totalSpent / 1e6).toFixed(2);
  const costPerMeter = distance > 0 ? (totalSpent / 1e6 / distance).toFixed(6) : "0";

  const shareText = `I ran ${(distance / 1000).toFixed(1)}km on $${spentFormatted} 🤖⚡ #BatchRunner`;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmitScore();
      setSubmitted(true);
    } catch {
      // submission failed silently
    }
    setSubmitting(false);
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center z-20
                    bg-black/70 backdrop-blur-sm">
      <div className="animate-slide-up flex flex-col items-center gap-5 p-8 rounded-2xl
                      bg-[var(--color-surface-light)] border border-[var(--color-surface-lighter)]
                      max-w-sm w-full mx-4">
        <h2 className="text-2xl font-bold text-[var(--color-accent-red)]">GAME OVER</h2>

        <div className="grid grid-cols-2 gap-4 w-full text-center">
          <Stat icon="🤖" label="Distance" value={`${distanceFormatted}m`} />
          <Stat icon="💰" label="Spent" value={`$${spentFormatted} (${voucherCount})`} />
          <Stat icon="⚡" label="Cost/meter" value={`$${costPerMeter}`} />
          {rank !== null && <Stat icon="🏆" label="Rank" value={`#${rank}`} />}
        </div>

        <div className="flex gap-3 w-full">
          <button
            onClick={() => {
              if (navigator.share) {
                navigator.share({ text: shareText }).catch(() => {});
              } else {
                navigator.clipboard.writeText(shareText).catch(() => {});
              }
            }}
            className="flex-1 px-4 py-2.5 text-sm border border-[var(--color-base-blue)]
                       text-[var(--color-base-blue)] rounded-xl hover:bg-[var(--color-base-blue)]/10
                       transition-colors cursor-pointer"
          >
            Share
          </button>
          <button
            onClick={onPlayAgain}
            className="flex-1 px-4 py-2.5 text-sm bg-[var(--color-base-blue)] text-white rounded-xl
                       font-bold hover:bg-[var(--color-base-blue-dark)] transition-colors cursor-pointer"
          >
            Play Again
          </button>
        </div>

        {!submitted && (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="text-xs text-[var(--color-text-secondary)] underline hover:text-white
                       transition-colors disabled:opacity-50 cursor-pointer"
          >
            {submitting ? "Submitting..." : "Submit to Leaderboard"}
          </button>
        )}
        {submitted && (
          <span className="text-xs text-[var(--color-accent-green)]">Score submitted!</span>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="p-3 rounded-lg bg-[var(--color-surface)]">
      <div className="text-lg font-bold">
        {icon} {value}
      </div>
      <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">{label}</div>
    </div>
  );
}
