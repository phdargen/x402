import type { GameState, VisualZone } from "./types";
import { GROUND_Y, DINO_WIDTH, DINO_HEIGHT } from "./types";
import { drawDino, drawGasPump, drawBank, drawCloud } from "./sprites";

function getVisualZone(distance: number): VisualZone {
  if (distance < 2000) return "calm";
  if (distance < 5000) return "dusk";
  if (distance < 7000) return "night";
  return "overdrive";
}

function getBackgroundGradient(
  ctx: CanvasRenderingContext2D,
  zone: VisualZone,
  height: number,
): CanvasGradient {
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  switch (zone) {
    case "calm":
      grad.addColorStop(0, "#1a1a3e");
      grad.addColorStop(1, "#0f0f28");
      break;
    case "dusk":
      grad.addColorStop(0, "#14142e");
      grad.addColorStop(1, "#0a0a1a");
      break;
    case "night":
      grad.addColorStop(0, "#0c0c1e");
      grad.addColorStop(1, "#050510");
      break;
    case "overdrive":
      grad.addColorStop(0, "#060612");
      grad.addColorStop(1, "#020208");
      break;
  }
  return grad;
}

function getGroundGlow(zone: VisualZone): { color: string; alpha: number } {
  switch (zone) {
    case "calm":
      return { color: "#0052FF", alpha: 0.3 };
    case "dusk":
      return { color: "#0052FF", alpha: 0.5 };
    case "night":
      return { color: "#457EFF", alpha: 0.7 };
    case "overdrive":
      return { color: "#457EFF", alpha: 0.9 };
  }
}

export function render(ctx: CanvasRenderingContext2D, state: GameState) {
  const { width, height } = ctx.canvas;
  const groundY = height * GROUND_Y;
  const zone = getVisualZone(state.distance);

  ctx.save();

  // Screen shake in overdrive
  if (state.screenShake > 0) {
    const shakeX = (Math.random() - 0.5) * state.screenShake;
    const shakeY = (Math.random() - 0.5) * state.screenShake;
    ctx.translate(shakeX, shakeY);
  }

  // Background gradient
  ctx.fillStyle = getBackgroundGradient(ctx, zone, height);
  ctx.fillRect(0, 0, width, height);

  // Speed lines (night + overdrive)
  if (zone === "night" || zone === "overdrive") {
    ctx.save();
    ctx.strokeStyle = zone === "overdrive" ? "rgba(69,126,255,0.15)" : "rgba(69,126,255,0.07)";
    ctx.lineWidth = 1;
    const lineCount = zone === "overdrive" ? 12 : 5;
    for (let i = 0; i < lineCount; i++) {
      const lineY = (((state.frameCount * 3 + i * 97) % height) + height) % height;
      ctx.beginPath();
      ctx.moveTo(0, lineY);
      ctx.lineTo(width * 0.3, lineY);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Clouds
  for (const cloud of state.clouds) {
    drawCloud(ctx, cloud.x, cloud.y, cloud.width, cloud.opacity);
  }

  // Ground line
  const glow = getGroundGlow(zone);
  ctx.save();
  ctx.strokeStyle = glow.color;
  ctx.globalAlpha = glow.alpha;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(width, groundY);
  ctx.stroke();

  // Ground dashes
  ctx.globalAlpha = glow.alpha * 0.5;
  ctx.lineWidth = 1;
  const dashLen = 20;
  const gapLen = 30;
  const offset = state.groundOffset % (dashLen + gapLen);
  for (let x = -offset; x < width; x += dashLen + gapLen) {
    ctx.beginPath();
    ctx.moveTo(x, groundY + 8);
    ctx.lineTo(x + dashLen, groundY + 8);
    ctx.stroke();
  }
  ctx.restore();

  // Obstacles
  for (const obs of state.obstacles) {
    if (obs.type === "gas-pump") {
      drawGasPump(ctx, obs.x, groundY - obs.height);
    } else if (obs.type === "bank") {
      drawBank(ctx, obs.x, groundY - obs.height);
    } else {
      drawGap(ctx, obs.x, groundY, obs.width);
    }
  }

  // Dino
  const dinoX = 80;
  const dinoScreenY = groundY - DINO_HEIGHT + state.dinoY;
  drawDino(
    ctx,
    dinoX,
    dinoScreenY,
    state.runFrame,
    state.jumpLockoutMs > 0,
  );

  // Gas pumps disable chained in-flight jumps without pausing the runner.
  if (state.jumpLockoutMs > 0) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 71, 87, 0.08)";
    ctx.fillRect(0, 0, width, height);

    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#ff4757";
    ctx.textAlign = "center";
    ctx.globalAlpha = 0.6 + Math.sin(state.frameCount * 0.15) * 0.4;
    ctx.fillText("AIR JUMPS DISABLED", width / 2, height * 0.35);
    ctx.restore();
  }

  // Particles
  for (const p of state.particles) {
    ctx.save();
    ctx.globalAlpha = p.life / p.maxLife;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    ctx.restore();
  }

  ctx.restore();
}

function drawGap(ctx: CanvasRenderingContext2D, x: number, groundY: number, width: number) {
  ctx.save();

  const depth = 85;
  const gradient = ctx.createLinearGradient(0, groundY, 0, groundY + depth);
  gradient.addColorStop(0, "rgba(255, 71, 87, 0.55)");
  gradient.addColorStop(0.15, "rgba(255, 71, 87, 0.2)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0.9)");
  ctx.fillStyle = gradient;
  ctx.fillRect(x, groundY - 2, width, depth);

  ctx.strokeStyle = "#ff4757";
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, groundY);
  ctx.lineTo(x + 10, groundY + 8);
  ctx.lineTo(x + 18, groundY);
  ctx.moveTo(x + width, groundY);
  ctx.lineTo(x + width - 10, groundY + 8);
  ctx.lineTo(x + width - 18, groundY);
  ctx.stroke();

  ctx.restore();
}
