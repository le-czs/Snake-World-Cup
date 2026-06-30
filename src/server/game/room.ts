import { GAME_CONFIG } from './constants.js';
import { id, inBounds, isOpposite, nextPosition, posKey, roomCode, samePos, token } from './utils.js';
import { PROTOCOL_VERSION, type DeathReason, type Direction, type FoodState, type GameEvent, type GameOverPayload, type GameOverPlayerResult, type GameSnapshotPayload, type PlayerPublicState, type PlayerStats, type RoomStatePayload, type SnakeAppearance, type SnakeState, type Vec2 } from '../../shared/protocol.js';

interface PlayerInternal {
  id: string;
  token: string;
  socketId?: string;
  nickname: string;
  country: string;
  appearance?: SnakeAppearance;
  isHost: boolean;
  isReady: boolean;
  connectionState: 'connected' | 'disconnected';
  gameState: 'lobby' | 'alive' | 'eliminated' | 'spectating';
  score: number;
  eatCount: number;
  joinOrder: number;
  joinedAt: number;
  disconnectedAt?: number;
  deathReason?: DeathReason;
  eliminatedAtTick?: number;
  survivalMs?: number;
  lastEatTick?: number;
  lastInputSeq: number;
  stats: PlayerStats;
}

export class GameRoom {
  readonly id = id('room');
  readonly code: string;
  readonly createdAt = Date.now();
  phase: 'lobby' | 'countdown' | 'running' | 'finished' = 'lobby';
  players = new Map<string, PlayerInternal>();
  snakes = new Map<string, SnakeState>();
  foods: FoodState[] = [];
  countdownStartedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  roundId = id('round');
  serverTick = 0;
  snapshotSeq = 0;
  latestSnapshot?: GameSnapshotPayload;
  pendingEvents: GameEvent[] = [];

  constructor(existingCodes: Set<string>) {
    let nextCode = roomCode();
    while (existingCodes.has(nextCode)) {
      nextCode = roomCode();
    }
    this.code = nextCode;
  }

  addPlayer(nickname: string, country: string, socketId: string, stats: Partial<PlayerStats> = {}, appearance?: SnakeAppearance): { playerId: string; playerToken: string } {
    if (this.phase !== 'lobby') {
      throw new Error('Room has already started');
    }
    if (this.players.size >= GAME_CONFIG.maxPlayers) {
      throw new Error('Room is full');
    }

    const player: PlayerInternal = {
      id: id('player'),
      token: token(),
      socketId,
      nickname: nickname.trim().slice(0, 20) || 'Player',
      country: country.trim().slice(0, 24) || 'World',
      appearance,
      isHost: this.players.size === 0,
      isReady: false,
      connectionState: 'connected',
      gameState: 'lobby',
      score: 0,
      eatCount: 0,
      joinOrder: this.players.size + 1,
      joinedAt: Date.now(),
      lastInputSeq: 0,
      stats: normalizeStats(stats)
    };

    this.players.set(player.id, player);
    return { playerId: player.id, playerToken: player.token };
  }

  authenticate(playerId: string, playerToken: string): PlayerInternal {
    const player = this.players.get(playerId);
    if (!player || player.token !== playerToken) {
      throw new Error('Invalid player credentials');
    }
    return player;
  }

  reconnect(playerId: string, playerToken: string, socketId: string): void {
    const player = this.authenticate(playerId, playerToken);
    if (player.connectionState === 'disconnected' && player.disconnectedAt) {
      const elapsed = Date.now() - player.disconnectedAt;
      if (elapsed > GAME_CONFIG.reconnectGraceMs) {
        throw new Error('Reconnect window expired');
      }
    }
    player.socketId = socketId;
    player.connectionState = 'connected';
    player.disconnectedAt = undefined;
  }

  disconnectSocket(socketId: string): PlayerInternal | undefined {
    const player = [...this.players.values()].find((candidate) => candidate.socketId === socketId);
    if (!player) return undefined;

    player.socketId = undefined;
    player.connectionState = 'disconnected';
    player.disconnectedAt = Date.now();
    return player;
  }

  setReady(playerId: string, playerToken: string, ready: boolean): void {
    const player = this.authenticate(playerId, playerToken);
    if (this.phase !== 'lobby') {
      throw new Error('Readiness can only change in lobby');
    }
    player.isReady = ready;
  }

  startCountdown(playerId: string, playerToken: string): void {
    const player = this.authenticate(playerId, playerToken);
    if (!player.isHost) {
      throw new Error('Only host can start the game');
    }
    if (this.phase !== 'lobby') {
      throw new Error('Game has already started');
    }
    if (this.players.size < GAME_CONFIG.minPlayers) {
      throw new Error('At least two players are required');
    }
    if (![...this.players.values()].every((candidate) => candidate.isReady || candidate.isHost)) {
      throw new Error('All non-host players must be ready');
    }

    this.resetRoundRuntime(false);
    this.roundId = id('round');
    this.phase = 'countdown';
    this.countdownStartedAt = Date.now();
  }

  maybeEnterRunning(now = Date.now()): boolean {
    if (this.phase !== 'countdown' || !this.countdownStartedAt) return false;
    if (now - this.countdownStartedAt < GAME_CONFIG.countdownMs) return false;

    this.phase = 'running';
    this.startedAt = now;
    this.serverTick = 0;
    this.snapshotSeq = 0;
    this.latestSnapshot = undefined;
    this.pendingEvents = [];
    this.players.forEach((player) => {
      player.gameState = 'alive';
      player.score = 0;
      player.eatCount = 0;
      player.deathReason = undefined;
      player.eliminatedAtTick = undefined;
      player.survivalMs = undefined;
      player.lastEatTick = undefined;
      player.lastInputSeq = 0;
    });
    this.spawnInitialSnakes();
    this.foods = [];
    this.ensureFoodCount();
    return true;
  }

  acceptInput(playerId: string, playerToken: string, inputSeq: number, direction: Direction, boost = false): boolean {
    const player = this.authenticate(playerId, playerToken);
    const snake = this.snakes.get(playerId);
    if (this.phase !== 'running' || player.gameState !== 'alive' || !snake) return false;
    if (inputSeq <= player.lastInputSeq) return false;
    player.lastInputSeq = inputSeq;
    snake.boostActive = boost && canBoost(snake);
    if (isOpposite(snake.direction, direction)) return false;
    snake.nextDirection = direction;
    return true;
  }

  tick(now = Date.now()): GameSnapshotPayload | undefined {
    if (this.phase === 'countdown') {
      this.maybeEnterRunning(now);
    }
    if (this.phase !== 'running' || !this.startedAt) return undefined;

    this.serverTick += 1;
    this.eliminateExpiredDisconnects(now);

    if (this.removeExpiredCorpseFoods(now)) {
      this.ensureFoodCount();
    }

    const isMovementTick = this.serverTick % GAME_CONFIG.moveEveryTicks === 0;
    const movingBoosted = this.applyBoostDrain(isMovementTick);
    if (isMovementTick) {
      this.stepMovement(now, movingBoosted);
    }

    const remainingMs = Math.max(0, GAME_CONFIG.matchDurationMs - (now - this.startedAt));
    if (remainingMs === 0 || this.alivePlayers().length <= 1) {
      this.finish(now);
    }

    this.latestSnapshot = this.toSnapshot(now);
    this.pendingEvents = [];
    return this.latestSnapshot;
  }

  finish(now = Date.now()): GameOverPayload {
    if (this.phase !== 'finished') {
      this.phase = 'finished';
      this.finishedAt = now;
      this.pendingEvents.push({ type: 'matchFinished', serverTick: this.serverTick });
      this.players.forEach((player) => {
        if (player.gameState === 'alive') {
          player.survivalMs = this.startedAt ? now - this.startedAt : 0;
        }
      });
    }
    return this.toGameOver();
  }

  leavePlayer(playerId: string, playerToken: string): PlayerInternal {
    if (this.phase !== 'lobby' && this.phase !== 'finished') {
      throw new Error('Game in progress');
    }

    const player = this.authenticate(playerId, playerToken);
    this.players.delete(player.id);
    this.snakes.delete(player.id);

    if (player.isHost && this.players.size > 0) {
      const nextHost = [...this.players.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0];
      nextHost.isHost = true;
    }

    return player;
  }

  returnToLobby(playerId: string, playerToken: string): void {
    this.authenticate(playerId, playerToken);
    if (this.phase !== 'finished' && this.phase !== 'lobby') {
      throw new Error('Match must be finished before returning to lobby');
    }

    this.phase = 'lobby';
    this.resetRoundRuntime(true);
  }

  toRoomState(selfId?: string): RoomStatePayload {
    const host = [...this.players.values()].find((player) => player.isHost);
    return {
      version: PROTOCOL_VERSION,
      roomId: this.id,
      roomCode: this.code,
      roundId: this.roundId,
      phase: this.phase,
      status: this.phase,
      minPlayers: GAME_CONFIG.minPlayers,
      maxPlayers: GAME_CONFIG.maxPlayers,
      players: this.publicPlayers(),
      ownerId: host?.id,
      hostId: host?.id,
      selfId,
      countdownRemainingMs: this.countdownRemainingMs(),
      remainingMs: this.remainingMs()
    };
  }

  toSnapshot(now = Date.now()): GameSnapshotPayload {
    return {
      version: PROTOCOL_VERSION,
      snapshotSeq: ++this.snapshotSeq,
      serverTick: this.serverTick,
      serverTime: now,
      roomId: this.id,
      roundId: this.roundId,
      roomState: this.phase,
      status: this.phase,
      map: { width: GAME_CONFIG.mapWidth, height: GAME_CONFIG.mapHeight },
      remainingMs: this.remainingMs(now) ?? 0,
      players: this.publicPlayers(),
      snakes: this.snapshotSnakes(),
      foods: this.snapshotFoods(),
      scores: this.scoreLines(),
      events: [...this.pendingEvents]
    };
  }

  toGameOver(): GameOverPayload {
    return {
      version: PROTOCOL_VERSION,
      roomId: this.id,
      roundId: this.roundId,
      serverTick: this.serverTick,
      finishedAt: this.finishedAt ?? Date.now(),
      results: this.rankResults(),
      rankings: this.scoreLines(),
      reason: this.remainingMs(this.finishedAt) === 0 ? 'timeUp' : 'lastAlive',
      serverTime: this.finishedAt ?? Date.now()
    };
  }

  private applyBoostDrain(isMovementTick: boolean): Set<string> {
    const boosted = new Set<string>();
    this.snakes.forEach((snake) => {
      if (!snake.alive) return;
      if (!canBoost(snake)) {
        snake.boostActive = false;
        snake.boostCharge = 0;
        snake.boostDrainCharge = 0;
        return;
      }
      if (!snake.boostActive) {
        snake.boostCharge = 0;
        snake.boostDrainCharge = 0;
        return;
      }

      snake.boostDrainCharge = (snake.boostDrainCharge ?? 0) + 1;
      if (isMovementTick) {
        snake.boostCharge = (snake.boostCharge ?? 0) + (GAME_CONFIG.boostMultiplier - 1);
        if (snake.boostCharge >= 1) {
          boosted.add(snake.playerId);
          snake.boostCharge = Math.max(0, snake.boostCharge - 1);
        }
      }
      if (snake.boostDrainCharge >= GAME_CONFIG.boostDrainTicks && canSpendBoostLength(snake)) {
        snake.body.pop();
        snake.boostDrainCharge = 0;
      }
      if (!canBoost(snake)) {
        snake.boostActive = false;
        snake.boostCharge = 0;
        snake.boostDrainCharge = 0;
      }
    });
    return boosted;
  }

  private resetRoundRuntime(resetReady: boolean): void {
    this.countdownStartedAt = undefined;
    this.startedAt = undefined;
    this.finishedAt = undefined;
    this.serverTick = 0;
    this.snapshotSeq = 0;
    this.latestSnapshot = undefined;
    this.pendingEvents = [];
    this.snakes.clear();
    this.foods = [];
    this.players.forEach((player) => {
      if (resetReady) player.isReady = false;
      player.gameState = 'lobby';
      player.score = 0;
      player.eatCount = 0;
      player.deathReason = undefined;
      player.eliminatedAtTick = undefined;
      player.survivalMs = undefined;
      player.lastEatTick = undefined;
      player.lastInputSeq = 0;
    });
  }

  private spawnInitialSnakes(): void {
    const starts = [
      { head: { x: 5, y: 5 }, direction: 'right' as const },
      { head: { x: GAME_CONFIG.mapWidth - 6, y: GAME_CONFIG.mapHeight - 6 }, direction: 'left' as const },
      { head: { x: 5, y: GAME_CONFIG.mapHeight - 6 }, direction: 'up' as const },
      { head: { x: GAME_CONFIG.mapWidth - 6, y: 5 }, direction: 'down' as const },
      { head: { x: Math.floor(GAME_CONFIG.mapWidth / 2), y: 5 }, direction: 'right' as const },
      { head: { x: Math.floor(GAME_CONFIG.mapWidth / 2), y: GAME_CONFIG.mapHeight - 6 }, direction: 'left' as const }
    ];

    this.snakes.clear();
    [...this.players.values()].forEach((player, index) => {
      const start = starts[index];
      const body = buildSnakeBody(start.head, start.direction, 4);
      this.snakes.set(player.id, {
        playerId: player.id,
        direction: start.direction,
        nextDirection: start.direction,
        body,
        pendingGrowth: 0,
        alive: true,
        boostActive: false,
        boostCharge: 0,
        boostDrainCharge: 0
      });
    });
  }

  private stepMovement(now: number, movingBoosted = new Set<string>()): void {
    const aliveSnakes = [...this.snakes.values()].filter((snake) => snake.alive);
    const movePlans = new Map<string, Vec2[]>();
    aliveSnakes.forEach((snake) => {
      const heads: Vec2[] = [];
      const steps = movingBoosted.has(snake.playerId) ? 2 : 1;
      for (let step = 0; step < steps; step += 1) {
        if (!isOpposite(snake.direction, snake.nextDirection)) {
          snake.direction = snake.nextDirection;
        }
        const player = this.players.get(snake.playerId);
        if (player?.lastInputSeq === 0) {
          const safeDirection = chooseIdleSafeDirection({ ...snake, body: [heads[step - 1] ?? snake.body[0], ...snake.body.slice(1)] }, GAME_CONFIG.mapWidth, GAME_CONFIG.mapHeight);
          if (safeDirection) {
            snake.direction = safeDirection;
            snake.nextDirection = safeDirection;
          }
        }
        heads.push(nextPosition(heads[step - 1] ?? snake.body[0], snake.direction));
      }
      movePlans.set(snake.playerId, heads);
    });
    const plannedHeads = finalHeads(movePlans);

    const eatenFoods = new Map<string, FoodState>();
    const foodEaters = new Map<string, string[]>();
    aliveSnakes.forEach((snake) => {
      const heads = movePlans.get(snake.playerId) ?? [];
      heads.forEach((head) => {
        const eatenFood = this.foods.find((food) => samePos(food.position, head));
        if (!eatenFood) return;
        if (eatenFood.type === 'corpse' && eatenFoods.has(eatenFood.foodId)) return;

        eatenFoods.set(eatenFood.foodId, eatenFood);
        foodEaters.set(eatenFood.foodId, [...(foodEaters.get(eatenFood.foodId) ?? []), snake.playerId]);
        const player = this.players.get(snake.playerId);
        if (player && eatenFood.ownerPlayerId !== snake.playerId) {
          player.score += eatenFood.value;
          player.eatCount += 1;
          player.lastEatTick = this.serverTick;
        }
        snake.pendingGrowth += eatenFood.growth;
      });
    });

    const deaths = new Map<string, DeathReason>();
    movePlans.forEach((heads, playerId) => {
      if (heads.some((head) => !inBounds(head, GAME_CONFIG.mapWidth, GAME_CONFIG.mapHeight))) {
        deaths.set(playerId, 'wall');
      }
    });

    const headBuckets = new Map<string, string[]>();
    movePlans.forEach((heads, playerId) => {
      heads.forEach((head) => {
        const key = posKey(head);
        headBuckets.set(key, [...(headBuckets.get(key) ?? []), playerId]);
      });
    });
    headBuckets.forEach((playerIds) => {
      if (playerIds.length > 1) {
        playerIds.forEach((playerId) => deaths.set(playerId, 'headToHead'));
      }
    });

    for (let i = 0; i < aliveSnakes.length; i += 1) {
      for (let j = i + 1; j < aliveSnakes.length; j += 1) {
        const a = aliveSnakes[i];
        const b = aliveSnakes[j];
        const aHead = plannedHeads.get(a.playerId);
        const bHead = plannedHeads.get(b.playerId);
        if (aHead && bHead && samePos(aHead, b.body[0]) && samePos(bHead, a.body[0])) {
          deaths.set(a.playerId, 'headToHead');
          deaths.set(b.playerId, 'headToHead');
        }
      }
    }

    const occupied = new Map<string, string[]>();
    aliveSnakes.forEach((snake) => {
      const heads = movePlans.get(snake.playerId) ?? [];
      const willGrow = this.foods.some((food) => heads.some((head) => samePos(food.position, head)));
      const bodyToCheck = willGrow ? snake.body : snake.body.slice(0, -1);
      bodyToCheck.forEach((segment) => {
        const key = posKey(segment);
        occupied.set(key, [...(occupied.get(key) ?? []), snake.playerId]);
      });
    });

    movePlans.forEach((heads, playerId) => {
      if (heads.some((head) => (occupied.get(posKey(head)) ?? []).length > 0)) {
        deaths.set(playerId, 'body');
      }
    });

    deaths.forEach((reason, playerId) => this.eliminate(playerId, reason, now));

    aliveSnakes.forEach((snake) => {
      if (!snake.alive) return;
      const heads = movePlans.get(snake.playerId) ?? [];
      heads.forEach((nextHead) => {
        snake.body.unshift(nextHead);
        if (snake.pendingGrowth > 0) {
          snake.pendingGrowth -= 1;
        } else {
          snake.body.pop();
        }
      });
    });

    foodEaters.forEach((playerIds, foodId) => {
      const food = eatenFoods.get(foodId);
      const isCorpse = food?.type === 'corpse';
      const event = {
        type: isCorpse ? 'corpseEaten' : 'foodEaten',
        serverTick: this.serverTick,
        playerIds,
        playerId: playerIds[0],
        foodId,
        position: food ? { ...food.position } : undefined,
        x: food?.position.x,
        y: food?.position.y,
        value: food?.value ?? GAME_CONFIG.foodScore,
        foodType: food?.type ?? 'normal',
        ownerPlayerId: food?.ownerPlayerId,
        reason: 'eaten'
      } satisfies GameEvent;
      this.pendingEvents.push(event);
      if (isCorpse) {
        console.log('[corpse] eaten', {
          roomId: this.id,
          roundId: this.roundId,
          serverTick: this.serverTick,
          corpseId: foodId,
          playerIds,
          ownerPlayerId: food?.ownerPlayerId
        });
      }
    });
    if (eatenFoods.size > 0) {
      this.foods = this.foods.filter((food) => !eatenFoods.has(food.foodId));
      this.pendingEvents.push({
        type: 'foodRemoved',
        serverTick: this.serverTick,
        removedFoodIds: [...eatenFoods.keys()],
        reason: 'eaten'
      });
      this.ensureFoodCount();
    }
  }

  private spawnCorpseFoods(playerId: string, now: number): void {
    const snake = this.snakes.get(playerId);
    if (!snake) return;

    const occupiedFood = new Set(this.foods.map((food) => posKey(food.position)));
    let spawned = 0;
    for (const segment of snake.body) {
      if (spawned >= GAME_CONFIG.maxCorpseFoodsPerDeath) break;
      const key = posKey(segment);
      if (occupiedFood.has(key)) continue;
      occupiedFood.add(key);
      this.foods.push({
        foodId: id('corpse'),
        position: { ...segment },
        type: 'corpse',
        value: GAME_CONFIG.corpseFoodScore,
        growth: GAME_CONFIG.corpseFoodGrowth,
        expiresAt: now + GAME_CONFIG.corpseFoodTtlMs,
        ownerPlayerId: playerId
      });
      spawned += 1;
    }
  }

  private removeExpiredCorpseFoods(now: number): boolean {
    const before = this.foods.length;
    this.foods = this.foods.filter((food) => !food.expiresAt || food.expiresAt > now);
    return this.foods.length !== before;
  }

  private ensureFoodCount(): void {
    const target = Math.min(GAME_CONFIG.maxFoods, Math.max(GAME_CONFIG.minFoods, this.players.size + 2));
    const blocked = new Set<string>();
    this.snakes.forEach((snake) => snake.body.forEach((segment) => blocked.add(posKey(segment))));
    this.foods.forEach((food) => blocked.add(posKey(food.position)));

    let guard = 0;
    while (this.foods.length < target && guard < 10_000) {
      guard += 1;
      const position = {
        x: Math.floor(Math.random() * GAME_CONFIG.mapWidth),
        y: Math.floor(Math.random() * GAME_CONFIG.mapHeight)
      };
      if (blocked.has(posKey(position))) continue;
      blocked.add(posKey(position));
      this.foods.push({
        foodId: id('food'),
        position,
        value: GAME_CONFIG.foodScore,
        growth: GAME_CONFIG.foodGrowth
      });
    }
  }

  private eliminateExpiredDisconnects(now: number): void {
    this.players.forEach((player) => {
      if (
        player.gameState === 'alive' &&
        player.connectionState === 'disconnected' &&
        player.disconnectedAt &&
        now - player.disconnectedAt > GAME_CONFIG.reconnectGraceMs
      ) {
        this.eliminate(player.id, 'disconnectTimeout', now);
      }
    });
  }

  private eliminate(playerId: string, reason: DeathReason, now: number): void {
    const player = this.players.get(playerId);
    const snake = this.snakes.get(playerId);
    if (!player || player.gameState === 'eliminated') return;

    player.gameState = 'eliminated';
    player.deathReason = reason;
    player.eliminatedAtTick = this.serverTick;
    player.survivalMs = this.startedAt ? now - this.startedAt : 0;
    if (snake) {
      this.spawnCorpseFoods(playerId, now);
      snake.alive = false;
    }
    this.pendingEvents.push({ type: 'playerEliminated', serverTick: this.serverTick, playerIds: [playerId], playerId, deathReason: reason, reason });
  }

  private alivePlayers(): PlayerInternal[] {
    return [...this.players.values()].filter((player) => player.gameState === 'alive');
  }

  private publicPlayers(): PlayerPublicState[] {
    return [...this.players.values()].map((player) => {
      const status = player.gameState === 'lobby'
        ? player.isReady
          ? 'ready'
          : player.connectionState
        : player.gameState === 'alive'
          ? 'alive'
          : player.gameState === 'eliminated'
            ? 'eliminated'
            : 'connected';
      return {
        playerId: player.id,
        id: player.id,
        nickname: player.nickname,
        name: player.nickname,
        country: player.country,
        teamId: player.country,
        appearance: player.appearance,
        isHost: player.isHost,
        isReady: player.isReady,
        connectionState: player.connectionState,
        gameState: player.gameState,
        status,
        score: player.score,
        eatCount: player.eatCount,
        deathReason: player.deathReason,
        survivalMs: player.survivalMs,
        ...player.stats
      };
    });
  }

  private snapshotSnakes(): SnakeState[] {
    return [...this.snakes.values()].map((snake) => {
      const body = snake.body.map((segment) => ({ ...segment }));
      const player = this.players.get(snake.playerId);
      const deathReason = snake.alive ? undefined : player?.deathReason;
      return { ...snake, country: player?.country, appearance: player?.appearance, body, segments: body.map((segment) => ({ ...segment })), deathReason };
    });
  }

  private snapshotFoods(): FoodState[] {
    return this.foods.map((food) => ({
      ...food,
      id: food.foodId,
      position: { ...food.position },
      x: food.position.x,
      y: food.position.y,
      type: food.type ?? 'normal',
      expiresAt: food.expiresAt,
      ownerPlayerId: food.ownerPlayerId
    }));
  }

  private scoreLines(): NonNullable<GameSnapshotPayload['scores']> {
    return this.rankResults().map((result) => ({
      playerId: result.playerId,
      rank: result.rank,
      score: result.score,
      eaten: result.eatCount,
      survivalMs: result.survivalMs,
      alive: result.aliveState === 'alive',
      deathReason: normalizeDeathReason(result.deathReason)
    }));
  }

  private countdownRemainingMs(now = Date.now()): number | undefined {
    if (this.phase !== 'countdown' || !this.countdownStartedAt) return undefined;
    return Math.max(0, GAME_CONFIG.countdownMs - (now - this.countdownStartedAt));
  }

  private remainingMs(now = Date.now()): number | undefined {
    if (!this.startedAt || (this.phase !== 'running' && this.phase !== 'finished')) return undefined;
    return Math.max(0, GAME_CONFIG.matchDurationMs - (now - this.startedAt));
  }

  private rankResults(): GameOverPlayerResult[] {
    const finishedAt = this.finishedAt ?? Date.now();
    return [...this.players.values()]
      .map((player) => ({ player, survivalMs: player.survivalMs ?? (this.startedAt ? finishedAt - this.startedAt : 0) }))
      .sort((a, b) => {
        if (b.player.score !== a.player.score) return b.player.score - a.player.score;
        if (b.survivalMs !== a.survivalMs) return b.survivalMs - a.survivalMs;
        return a.player.joinOrder - b.player.joinOrder;
      })
      .map(({ player, survivalMs }, index) => ({
        playerId: player.id,
        nickname: player.nickname,
        country: player.country,
        appearance: player.appearance,
        rank: index + 1,
        score: player.score,
        aliveState: player.gameState === 'alive' ? 'alive' : 'eliminated',
        deathReason: player.deathReason,
        eatCount: player.eatCount,
        survivalMs,
        lastEatTick: player.lastEatTick,
        joinOrder: player.joinOrder,
        ...player.stats
      }));
  }
}

function titleForWins(wins: number): string {
  if (wins >= 1000) return '大师';
  if (wins >= 500) return '世界杯名将';
  if (wins >= 100) return '蛇王候选';
  if (wins >= 50) return '球场新星';
  if (wins >= 10) return '入门';
  if (wins >= 1) return '门外汉';
  return '新秀';
}

function normalizeStats(stats: Partial<PlayerStats> = {}): PlayerStats {
  const wins = Math.max(0, Number(stats.wins) || 0);
  const losses = Math.max(0, Number(stats.losses) || 0);
  const gamesPlayed = Math.max(wins + losses, Number(stats.gamesPlayed) || 0);
  const bestScore = Math.max(0, Number(stats.bestScore) || 0);
  const winRate = gamesPlayed ? Math.round((wins / gamesPlayed) * 100) : 0;
  return { wins, losses, gamesPlayed, winRate, bestScore, title: titleForWins(wins) };
}

function canBoost(snake: SnakeState): boolean {
  return snake.alive && snake.body.length > GAME_CONFIG.boostMinLength;
}

function canSpendBoostLength(snake: SnakeState): boolean {
  return snake.body.length > GAME_CONFIG.boostMinLength;
}

function finalHeads(movePlans: Map<string, Vec2[]>): Map<string, Vec2> {
  const heads = new Map<string, Vec2>();
  movePlans.forEach((plan, playerId) => {
    const head = plan.at(-1);
    if (head) heads.set(playerId, head);
  });
  return heads;
}

function normalizeDeathReason(reason?: DeathReason): 'wall' | 'body' | 'headOn' | 'disconnected' | 'unknown' | undefined {
  if (!reason) return undefined;
  if (reason === 'headToHead') return 'headOn';
  if (reason === 'disconnectTimeout') return 'disconnected';
  return reason;
}

function buildSnakeBody(head: Vec2, direction: Direction, length: number): Vec2[] {
  const body: Vec2[] = [];
  for (let i = 0; i < length; i += 1) {
    switch (direction) {
      case 'right':
        body.push({ x: head.x - i, y: head.y });
        break;
      case 'left':
        body.push({ x: head.x + i, y: head.y });
        break;
      case 'down':
        body.push({ x: head.x, y: head.y - i });
        break;
      case 'up':
        body.push({ x: head.x, y: head.y + i });
        break;
    }
  }
  return body;
}

function chooseIdleSafeDirection(snake: SnakeState, width: number, height: number): Direction | undefined {
  if (inBounds(nextPosition(snake.body[0], snake.direction), width, height)) return undefined;

  const turnOptions: Record<Direction, Direction[]> = {
    right: ['down', 'up'],
    left: ['up', 'down'],
    up: ['right', 'left'],
    down: ['left', 'right']
  };
  const bodyToCheck = snake.body.slice(0, -1);
  return turnOptions[snake.direction].find((direction) => {
    const next = nextPosition(snake.body[0], direction);
    return inBounds(next, width, height) && !bodyToCheck.some((segment) => samePos(segment, next));
  });
}
