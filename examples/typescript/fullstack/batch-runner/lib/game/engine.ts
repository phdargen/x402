import type { GameState, Obstacle, Cloud, ObstacleType } from "./types";
import {
  GROUND_Y,
  DINO_WIDTH,
  DINO_HEIGHT,
  GRAVITY,
  JUMP_VELOCITY,
  BASE_SPEED,
  MAX_SPEED,
  SPEED_INCREMENT,
  OBSTACLE_MIN_GAP,
  FREEZE_DURATION_MS,
  BANK_PENALTY_JUMPS,
} from "./types";

export function createInitialState(): GameState {
  return {
    phase: "idle",
    distance: 0,
    speed: BASE_SPEED,
    dinoY: 0,
    dinoVelocity: 0,
    isJumping: false,
    obstacles: [],
    particles: [],
    clouds: initClouds(),
    groundOffset: 0,
    frameCount: 0,
    freezeTimer: 0,
    bankPenaltyJumpsLeft: 0,
    screenShake: 0,
    lastObstacleDistance: 0,
    runFrame: 0,
    runFrameTimer: 0,
  };
}

function initClouds(): Cloud[] {
  return Array.from({ length: 5 }, () => ({
    x: Math.random() * 800,
    y: 30 + Math.random() * 100,
    width: 40 + Math.random() * 60,
    opacity: 0.1 + Math.random() * 0.15,
    speed: 0.3 + Math.random() * 0.5,
  }));
}

export type EngineCallbacks = {
  onJumpCost: () => boolean; // returns false if insufficient balance
  onHitGasPump: () => void;
  onHitBank: () => void;
  onGameOver: () => void;
  canvasWidth: number;
  canvasHeight: number;
};

/**
 * Attempts a jump. Returns true if the jump succeeded (dino was on ground and had balance).
 */
export function tryJump(state: GameState, callbacks: EngineCallbacks): boolean {
  if (state.phase === "frozen" || state.phase === "game-over") return false;
  if (state.isJumping) return false;

  const canPay = callbacks.onJumpCost();
  if (!canPay) return false;

  if (state.phase === "idle") {
    state.phase = "running";
  }

  state.dinoVelocity = JUMP_VELOCITY;
  state.isJumping = true;

  spawnJumpParticles(state, 80 + DINO_WIDTH / 2, callbacks.canvasHeight * GROUND_Y);
  return true;
}

export function tick(state: GameState, dt: number, callbacks: EngineCallbacks): GameState {
  if (state.phase === "idle" || state.phase === "game-over") {
    updateClouds(state, callbacks.canvasWidth);
    state.frameCount++;
    return state;
  }

  // Freeze handling
  if (state.phase === "frozen") {
    state.freezeTimer -= dt;
    if (state.freezeTimer <= 0) {
      state.phase = "running";
      state.freezeTimer = 0;
    }
    updateParticles(state);
    state.frameCount++;
    return state;
  }

  // Speed ramp
  state.speed = Math.min(MAX_SPEED, state.speed + SPEED_INCREMENT * dt);

  // Distance
  state.distance += state.speed * (dt / 16);
  state.groundOffset += state.speed;

  // Dino physics
  if (state.isJumping) {
    state.dinoVelocity += GRAVITY;
    state.dinoY += state.dinoVelocity;
    if (state.dinoY >= 0) {
      state.dinoY = 0;
      state.dinoVelocity = 0;
      state.isJumping = false;
    }
  }

  // Run animation
  state.runFrameTimer += dt;
  if (state.runFrameTimer > 120) {
    state.runFrame = (state.runFrame + 1) % 4;
    state.runFrameTimer = 0;
  }

  // Spawn obstacles
  maybeSpawnObstacle(state, callbacks);

  // Move obstacles
  for (const obs of state.obstacles) {
    obs.x -= state.speed;
  }

  // Collision detection
  checkCollisions(state, callbacks);

  // Cull offscreen obstacles
  state.obstacles = state.obstacles.filter((o) => o.x + o.width > -50);

  // Update particles and clouds
  updateParticles(state);
  updateClouds(state, callbacks.canvasWidth);

  // Screen shake decay
  if (state.screenShake > 0) {
    state.screenShake = Math.max(0, state.screenShake - 0.15);
  }
  if (state.distance > 7000) {
    state.screenShake = Math.max(state.screenShake, 1.5);
  }

  state.frameCount++;
  return state;
}

function maybeSpawnObstacle(state: GameState, callbacks: EngineCallbacks) {
  const gap = getObstacleGap(state.distance);
  if (state.distance - state.lastObstacleDistance < gap) return;

  const type: ObstacleType = Math.random() < 0.55 ? "gas-pump" : "bank";
  const obs: Obstacle = {
    type,
    x: callbacks.canvasWidth + 20,
    y: 0,
    width: type === "gas-pump" ? 36 : 42,
    height: type === "gas-pump" ? 48 : 48,
    passed: false,
  };

  state.obstacles.push(obs);
  state.lastObstacleDistance = state.distance;
}

function getObstacleGap(distance: number): number {
  if (distance < 2000) return OBSTACLE_MIN_GAP;
  if (distance < 5000) return OBSTACLE_MIN_GAP * 0.7;
  if (distance < 7000) return OBSTACLE_MIN_GAP * 0.5;
  return OBSTACLE_MIN_GAP * 0.35;
}

function checkCollisions(state: GameState, callbacks: EngineCallbacks) {
  const dinoX = 80;
  const groundY = callbacks.canvasHeight * GROUND_Y;
  const dinoScreenY = groundY - DINO_HEIGHT + state.dinoY;
  const dinoRect = {
    x: dinoX + 6,
    y: dinoScreenY + 4,
    w: DINO_WIDTH - 12,
    h: DINO_HEIGHT - 8,
  };

  for (const obs of state.obstacles) {
    if (obs.passed) continue;

    const obsRect = {
      x: obs.x + 4,
      y: groundY - obs.height + 4,
      w: obs.width - 8,
      h: obs.height - 4,
    };

    if (!rectsOverlap(dinoRect, obsRect)) continue;

    obs.passed = true;

    if (obs.type === "gas-pump") {
      state.phase = "frozen";
      state.freezeTimer = FREEZE_DURATION_MS;
      callbacks.onHitGasPump();
      spawnHitParticles(state, obs.x, groundY - obs.height / 2, "#ff6b35");
    } else {
      state.bankPenaltyJumpsLeft = BANK_PENALTY_JUMPS;
      callbacks.onHitBank();
      spawnHitParticles(state, obs.x, groundY - obs.height / 2, "#00d68f");
    }
  }
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function spawnJumpParticles(state: GameState, x: number, y: number) {
  for (let i = 0; i < 6; i++) {
    state.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * -3 - 1,
      life: 20,
      maxLife: 20,
      color: "#457EFF",
      size: 2 + Math.random() * 2,
    });
  }
}

function spawnHitParticles(state: GameState, x: number, y: number, color: string) {
  for (let i = 0; i < 10; i++) {
    state.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 6,
      vy: (Math.random() - 0.5) * 6,
      life: 30,
      maxLife: 30,
      color,
      size: 2 + Math.random() * 3,
    });
  }
}

function updateParticles(state: GameState) {
  for (const p of state.particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.1;
    p.life--;
  }
  state.particles = state.particles.filter((p) => p.life > 0);
}

function updateClouds(state: GameState, canvasWidth: number) {
  for (const c of state.clouds) {
    c.x -= c.speed + (state.phase === "running" ? state.speed * 0.1 : 0);
    if (c.x + c.width < 0) {
      c.x = canvasWidth + Math.random() * 100;
      c.y = 30 + Math.random() * 100;
      c.width = 40 + Math.random() * 60;
    }
  }
}
