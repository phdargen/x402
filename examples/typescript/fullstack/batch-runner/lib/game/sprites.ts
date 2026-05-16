/**
 * Pixel art rendering functions for game entities.
 * All sprites use a consistent retro pixel style with Base blue (#0052FF) as the primary color.
 */

const BASE_BLUE = "#0052FF";
const BASE_BLUE_LIGHT = "#457EFF";
const BASE_BLUE_DARK = "#003ECF";

export function drawDino(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: number,
  jumpDisabled: boolean,
) {
  const p = 3; // pixel size
  ctx.save();
  ctx.translate(x, y);

  const bodyColor = jumpDisabled ? "#8888aa" : BASE_BLUE;
  const accentColor = jumpDisabled ? "#666688" : BASE_BLUE_DARK;
  const eyeGlow = jumpDisabled ? "#ff4757" : "#00d68f";

  // Body
  ctx.fillStyle = bodyColor;
  ctx.fillRect(4 * p, 0, 6 * p, 4 * p); // head
  ctx.fillRect(2 * p, 4 * p, 8 * p, 6 * p); // torso
  ctx.fillRect(6 * p, 10 * p, 4 * p, 3 * p); // tail connector
  ctx.fillRect(9 * p, 8 * p, 3 * p, 3 * p); // tail

  // Visor / eye
  ctx.fillStyle = accentColor;
  ctx.fillRect(4 * p, 1 * p, 6 * p, 2 * p);
  ctx.fillStyle = eyeGlow;
  ctx.fillRect(8 * p, 1 * p, 2 * p, 1 * p);

  // Arm
  ctx.fillStyle = accentColor;
  ctx.fillRect(1 * p, 5 * p, 2 * p, 3 * p);

  // Legs (animated)
  ctx.fillStyle = bodyColor;
  const legPhase = frame % 4;
  if (legPhase < 2) {
    ctx.fillRect(3 * p, 10 * p, 2 * p, 4 * p); // left leg forward
    ctx.fillRect(7 * p, 10 * p, 2 * p, 3 * p); // right leg back
  } else {
    ctx.fillRect(3 * p, 10 * p, 2 * p, 3 * p); // left leg back
    ctx.fillRect(7 * p, 10 * p, 2 * p, 4 * p); // right leg forward
  }

  // Feet
  ctx.fillStyle = accentColor;
  if (legPhase < 2) {
    ctx.fillRect(2 * p, 14 * p, 3 * p, 1 * p);
    ctx.fillRect(6 * p, 13 * p, 3 * p, 1 * p);
  } else {
    ctx.fillRect(2 * p, 13 * p, 3 * p, 1 * p);
    ctx.fillRect(6 * p, 14 * p, 3 * p, 1 * p);
  }

  ctx.restore();
}

export function drawGasPump(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const p = 3;
  ctx.save();
  ctx.translate(x, y);

  // Base
  ctx.fillStyle = "#555566";
  ctx.fillRect(2 * p, 10 * p, 8 * p, 6 * p);

  // Body
  ctx.fillStyle = "#ff6b35";
  ctx.fillRect(3 * p, 3 * p, 6 * p, 7 * p);

  // Nozzle top
  ctx.fillStyle = "#333344";
  ctx.fillRect(4 * p, 0, 4 * p, 3 * p);

  // Hose
  ctx.fillStyle = "#333344";
  ctx.fillRect(0, 4 * p, 3 * p, 2 * p);
  ctx.fillRect(0, 4 * p, 1 * p, 5 * p);

  // Screen/meter
  ctx.fillStyle = "#00d68f";
  ctx.fillRect(4 * p, 5 * p, 4 * p, 3 * p);

  // Dollar sign on screen
  ctx.fillStyle = "#003322";
  ctx.fillRect(5 * p, 5 * p, 2 * p, 1 * p);
  ctx.fillRect(5 * p, 7 * p, 2 * p, 1 * p);
  ctx.fillRect(5 * p, 6 * p, 1 * p, 1 * p);
  ctx.fillRect(6 * p, 6 * p, 1 * p, 1 * p);

  ctx.restore();
}

export function drawBank(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const p = 3;
  ctx.save();
  ctx.translate(x, y);

  // Roof / pediment (triangle-ish)
  ctx.fillStyle = "#ddcc88";
  ctx.fillRect(0, 2 * p, 14 * p, 2 * p);
  ctx.fillRect(2 * p, 0, 10 * p, 2 * p);

  // Body
  ctx.fillStyle = "#ccbb77";
  ctx.fillRect(0, 4 * p, 14 * p, 10 * p);

  // Columns
  ctx.fillStyle = "#eeddaa";
  ctx.fillRect(1 * p, 4 * p, 2 * p, 10 * p);
  ctx.fillRect(6 * p, 4 * p, 2 * p, 10 * p);
  ctx.fillRect(11 * p, 4 * p, 2 * p, 10 * p);

  // Door
  ctx.fillStyle = "#886633";
  ctx.fillRect(4 * p, 8 * p, 3 * p, 6 * p);

  // Dollar sign
  ctx.fillStyle = "#00d68f";
  ctx.font = `bold ${p * 4}px monospace`;
  ctx.fillText("$", 8.5 * p, 8 * p);

  // Steps
  ctx.fillStyle = "#bbaa66";
  ctx.fillRect(0, 14 * p, 14 * p, 2 * p);

  ctx.restore();
}

export function drawCloud(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  opacity: number,
) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = "#ffffff";
  const h = width * 0.4;
  ctx.beginPath();
  ctx.ellipse(x + width * 0.3, y + h * 0.5, width * 0.3, h * 0.5, 0, 0, Math.PI * 2);
  ctx.ellipse(x + width * 0.6, y + h * 0.3, width * 0.25, h * 0.45, 0, 0, Math.PI * 2);
  ctx.ellipse(x + width * 0.8, y + h * 0.55, width * 0.2, h * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawJumpSparkle(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const sparkles = [
    { dx: -8, dy: 4, size: 3 },
    { dx: 8, dy: -2, size: 2 },
    { dx: -4, dy: -8, size: 2.5 },
    { dx: 12, dy: 6, size: 2 },
  ];
  ctx.save();
  ctx.fillStyle = BASE_BLUE_LIGHT;
  for (const s of sparkles) {
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x + s.dx - s.size / 2, y + s.dy - s.size / 2, s.size, s.size);
  }
  ctx.restore();
}
