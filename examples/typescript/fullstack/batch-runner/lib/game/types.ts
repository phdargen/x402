export type ObstacleType = "gas-pump" | "bank" | "gap";

export type Obstacle = {
  type: ObstacleType;
  x: number;
  y: number;
  width: number;
  height: number;
  passed: boolean;
};

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
};

export type Cloud = {
  x: number;
  y: number;
  width: number;
  opacity: number;
  speed: number;
};

export type GamePhase = "idle" | "running" | "falling" | "game-over";

export type VisualZone = "calm" | "dusk" | "night" | "overdrive";

export type DinoReaction = "none" | "obstacle-hit" | "gap-fall";

export type GameState = {
  phase: GamePhase;
  distance: number;
  speed: number;
  dinoY: number;
  dinoVelocity: number;
  isJumping: boolean;
  obstacles: Obstacle[];
  particles: Particle[];
  clouds: Cloud[];
  groundOffset: number;
  frameCount: number;
  jumpCooldownMs: number;
  jumpLockoutMs: number;
  bankPenaltyJumpsLeft: number;
  screenShake: number;
  lastObstacleDistance: number;
  runFrame: number;
  runFrameTimer: number;
  dinoReaction: DinoReaction;
  dinoReactionTimerMs: number;
};

export const GROUND_Y = 0.78;
export const DINO_WIDTH = 40;
export const DINO_HEIGHT = 48;
export const GRAVITY = 0.65;
export const JUMP_VELOCITY = -14.53;
export const BASE_SPEED = 4;
export const MAX_SPEED = 12;
export const SPEED_INCREMENT = 0.0003;
export const OBSTACLE_MIN_GAP = 300;
export const JUMP_COOLDOWN_MS = 320;
export const GAS_LOCKOUT_DURATION_MS = 2200;
export const BANK_PENALTY_JUMPS = 5;
