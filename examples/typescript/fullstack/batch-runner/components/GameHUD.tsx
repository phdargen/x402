"use client";

type GameHUDProps = {
  balance: number;
  distance: number;
  voucherCount: number;
  bankPenaltyJumpsLeft: number;
  jumpCost: number;
  jumpRecharge: number;
  jumpStatus: "ready" | "charging" | "signing" | "batch-disabled";
  gasLockoutMs: number;
};

export function GameHUD({
  balance,
  distance,
  voucherCount,
  bankPenaltyJumpsLeft,
  jumpCost,
  jumpRecharge,
  jumpStatus,
  gasLockoutMs,
}: GameHUDProps) {
  const balanceFormatted = (balance / 1e6).toFixed(3);
  const distanceFormatted = Math.floor(distance).toLocaleString();
  const jumpCostFormatted = (jumpCost / 1e6).toFixed(3);
  const lockoutSeconds = Math.ceil(gasLockoutMs / 1000);

  return (
    <div className="absolute top-0 left-0 right-0 p-3 flex items-center justify-between
                    pointer-events-none select-none z-10">
      <div className="flex items-center gap-4 text-xs">
        <HUDStat
          icon="💰"
          value={`$${balanceFormatted}`}
          color={balance < 100000 ? "var(--color-accent-red)" : "var(--color-accent-green)"}
        />
        <HUDStat icon="🤖" value={`${distanceFormatted}m`} color="var(--color-base-blue-light)" />
        <HUDStat icon="✍️" value={`${voucherCount}`} color="var(--color-text-secondary)" />
      </div>

      <div className="flex items-center gap-3 text-xs">
        <JumpRecharge status={jumpStatus} progress={jumpRecharge} />
        {bankPenaltyJumpsLeft > 0 && (
          <span className="px-2 py-1 rounded bg-[var(--color-accent-orange)]/20 text-[var(--color-accent-orange)]">
            ⚠️ ${jumpCostFormatted}/jump ({bankPenaltyJumpsLeft} left)
          </span>
        )}
        {gasLockoutMs > 0 && (
          <span className="px-2 py-1 rounded bg-[var(--color-accent-red)]/20 text-[var(--color-accent-red)] animate-pulse">
            ⛽ AIR JUMPS OFF {lockoutSeconds}s
          </span>
        )}
      </div>
    </div>
  );
}

function JumpRecharge({
  status,
  progress,
}: {
  status: GameHUDProps["jumpStatus"];
  progress: number;
}) {
  const label =
    status === "ready"
      ? "JUMP READY"
      : status === "signing"
        ? "SIGNING"
        : status === "batch-disabled"
          ? "LAND FIRST"
          : "RECHARGE";
  const color =
    status === "batch-disabled"
      ? "var(--color-accent-red)"
      : status === "ready"
        ? "var(--color-accent-green)"
        : "var(--color-base-blue-light)";

  return (
    <span className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--color-surface)]/80">
      <span style={{ color }} className="font-bold">
        {label}
      </span>
      <span className="w-14 h-1.5 rounded-full bg-white/15 overflow-hidden">
        <span
          className="block h-full transition-[width] duration-75"
          style={{ width: `${Math.round(progress * 100)}%`, backgroundColor: color }}
        />
      </span>
    </span>
  );
}

function HUDStat({ icon, value, color }: { icon: string; value: string; color: string }) {
  return (
    <span className="flex items-center gap-1">
      <span>{icon}</span>
      <span style={{ color }} className="font-bold tabular-nums">
        {value}
      </span>
    </span>
  );
}
