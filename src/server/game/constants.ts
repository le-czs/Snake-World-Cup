export const GAME_CONFIG = {
  minPlayers: 2,
  maxPlayers: 6,
  mapWidth: 40,
  mapHeight: 28,
  tickRate: 12,
  moveEveryTicks: 2,
  matchDurationMs: 120_000,
  countdownMs: 3_000,
  reconnectGraceMs: 15_000,
  foodScore: 10,
  foodGrowth: 1,
  corpseFoodScore: 5,
  corpseFoodGrowth: 0,
  corpseFoodTtlMs: 10_000,
  maxCorpseFoodsPerDeath: 10,
  minFoods: 4,
  maxFoods: 8
} as const;

export const TICK_MS = Math.floor(1000 / GAME_CONFIG.tickRate);
