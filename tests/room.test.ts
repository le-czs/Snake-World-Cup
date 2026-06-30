import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../src/server/game/room.js';
import { GAME_CONFIG } from '../src/server/game/constants.js';

function runningRoom(players = 2): GameRoom {
  const room = new GameRoom(new Set());
  const auths = [];
  for (let i = 0; i < players; i += 1) {
    auths.push(room.addPlayer(`P${i + 1}`, `C${i + 1}`, `socket-${i + 1}`));
  }
  for (let i = 1; i < auths.length; i += 1) {
    room.setReady(auths[i].playerId, auths[i].playerToken, true);
  }
  room.startCountdown(auths[0].playerId, auths[0].playerToken);
  room.maybeEnterRunning(Date.now() + GAME_CONFIG.countdownMs);
  return room;
}

test('room starts only after countdown with initial snakes and foods', () => {
  const room = runningRoom(4);
  assert.equal(room.phase, 'running');
  assert.equal(room.snakes.size, 4);
  assert.equal(room.foods.length, 6);
});

test('idle three-player starts stay alive long enough for players to react', () => {
  const room = runningRoom(3);

  for (let i = 0; i < 12 * GAME_CONFIG.tickRate; i += 1) {
    room.tick(Date.now() + i * 100);
    assert.equal(room.phase, 'running');
  }

  const players = room.toRoomState().players;
  assert.equal(players.filter((player) => player.gameState === 'alive').length, 3);
});

test('idle wall protection stops after the player has input', () => {
  const room = runningRoom(3);
  const snake = [...room.snakes.values()][0];
  const player = room.players.get(snake.playerId);
  assert.ok(player);

  player.lastInputSeq = 1;
  snake.body = [{ x: GAME_CONFIG.mapWidth - 1, y: 5 }, { x: GAME_CONFIG.mapWidth - 2, y: 5 }, { x: GAME_CONFIG.mapWidth - 3, y: 5 }, { x: GAME_CONFIG.mapWidth - 4, y: 5 }];
  snake.direction = 'right';
  snake.nextDirection = 'right';

  room.tick(Date.now());
  room.tick(Date.now());

  const updated = room.toRoomState().players.find((candidate) => candidate.playerId === snake.playerId);
  assert.equal(updated?.gameState, 'eliminated');
  assert.equal(updated?.deathReason, 'wall');
});

test('same tick food can credit multiple players and food respawns once', () => {
  const room = runningRoom(2);
  const snakes = [...room.snakes.values()];
  snakes[0].body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  snakes[0].direction = 'right';
  snakes[0].nextDirection = 'right';
  snakes[1].body = [{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }, { x: 14, y: 10 }];
  snakes[1].direction = 'left';
  snakes[1].nextDirection = 'left';
  room.foods = [{ foodId: 'shared', position: { x: 10, y: 10 }, value: 10, growth: 1 }];
  room.tick(Date.now());
  const snapshot = room.tick(Date.now());

  assert.equal(room.toRoomState().players[0].score, 10);
  assert.equal(room.toRoomState().players[1].score, 10);
  assert.equal(room.foods.filter((food) => food.foodId === 'shared').length, 0);
  assert.ok(room.foods.length >= GAME_CONFIG.minFoods);
  assert.ok(snapshot?.events.some((event) => event.type === 'foodEaten' && event.playerIds?.length === 2));
});

test('head-to-head collision eliminates both snakes', () => {
  const room = runningRoom(2);
  const snakes = [...room.snakes.values()];
  snakes[0].body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  snakes[0].direction = 'right';
  snakes[0].nextDirection = 'right';
  snakes[1].body = [{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }, { x: 14, y: 10 }];
  snakes[1].direction = 'left';
  snakes[1].nextDirection = 'left';
  room.foods = [];
  room.tick(Date.now());
  room.tick(Date.now());

  const players = room.toRoomState().players;
  assert.equal(players[0].deathReason, 'headToHead');
  assert.equal(players[1].deathReason, 'headToHead');
});

test('three-player match continues after one death and corpse food scores', () => {
  const room = runningRoom(3);
  const snakes = [...room.snakes.values()];
  const victim = snakes[0];
  const hunter = snakes[1];
  const bystander = snakes[2];

  const victimPlayer = room.players.get(victim.playerId);
  assert.ok(victimPlayer);
  victimPlayer.lastInputSeq = 1;
  victim.body = [{ x: 0, y: 10 }, { x: 1, y: 10 }, { x: 2, y: 10 }, { x: 3, y: 10 }];
  victim.direction = 'left';
  victim.nextDirection = 'left';
  hunter.body = [{ x: 20, y: 10 }, { x: 21, y: 10 }, { x: 22, y: 10 }, { x: 23, y: 10 }];
  hunter.direction = 'left';
  hunter.nextDirection = 'left';
  bystander.body = [{ x: 20, y: 20 }, { x: 21, y: 20 }, { x: 22, y: 20 }, { x: 23, y: 20 }];
  bystander.direction = 'left';
  bystander.nextDirection = 'left';
  room.foods = [];

  room.tick(Date.now());
  let snapshot = room.tick(Date.now());

  assert.equal(room.phase, 'running');
  assert.equal(snapshot?.foods.filter((food) => food.type === 'corpse').length, 4);
  assert.equal(room.toRoomState().players.find((player) => player.playerId === victim.playerId)?.gameState, 'eliminated');

  hunter.body = [{ x: 1, y: 10 }, { x: 1, y: 11 }, { x: 1, y: 12 }, { x: 1, y: 13 }];
  hunter.direction = 'left';
  hunter.nextDirection = 'left';
  room.tick(Date.now());
  snapshot = room.tick(Date.now());

  const hunterState = room.toRoomState().players.find((player) => player.playerId === hunter.playerId);
  const corpseEvent = snapshot?.events.find((event) => event.type === 'corpseEaten' && event.foodType === 'corpse');
  assert.equal(hunterState?.score, GAME_CONFIG.corpseFoodScore);
  assert.match(corpseEvent?.foodId ?? '', /^corpse_/);
  assert.equal(corpseEvent?.ownerPlayerId, victim.playerId);
  assert.equal(snapshot?.foods.some((food) => food.foodId === corpseEvent?.foodId), false);
  assert.ok(snapshot?.events.some((event) => event.type === 'foodRemoved' && event.removedFoodIds?.includes(corpseEvent?.foodId ?? '')));
});

test('same corpse food credits only one player and is removed when multiple players reach it', () => {
  const room = runningRoom(3);
  const snakes = [...room.snakes.values()];
  const leftHunter = snakes[0];
  const rightHunter = snakes[1];
  const owner = snakes[2];

  leftHunter.body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  leftHunter.direction = 'right';
  leftHunter.nextDirection = 'right';
  rightHunter.body = [{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }, { x: 14, y: 10 }];
  rightHunter.direction = 'left';
  rightHunter.nextDirection = 'left';
  owner.body = [{ x: 20, y: 20 }, { x: 21, y: 20 }, { x: 22, y: 20 }, { x: 23, y: 20 }];
  owner.direction = 'left';
  owner.nextDirection = 'left';
  room.foods = [{
    foodId: 'corpse-shared',
    position: { x: 10, y: 10 },
    type: 'corpse',
    value: GAME_CONFIG.corpseFoodScore,
    growth: GAME_CONFIG.corpseFoodGrowth,
    ownerPlayerId: owner.playerId
  }];

  room.tick(Date.now());
  const snapshot = room.tick(Date.now());
  const players = room.toRoomState().players;
  const leftState = players.find((player) => player.playerId === leftHunter.playerId);
  const rightState = players.find((player) => player.playerId === rightHunter.playerId);

  assert.equal((leftState?.score ?? 0) + (rightState?.score ?? 0), GAME_CONFIG.corpseFoodScore);
  assert.equal([leftState?.score, rightState?.score].filter((score) => score === GAME_CONFIG.corpseFoodScore).length, 1);
  assert.equal(room.foods.filter((food) => food.foodId === 'corpse-shared').length, 0);
  assert.equal(snapshot?.events.filter((event) => event.foodId === 'corpse-shared' && event.type === 'corpseEaten').length, 1);
  assert.equal(snapshot?.events.filter((event) => event.type === 'foodRemoved' && event.removedFoodIds?.includes('corpse-shared')).length, 1);
});

test('disconnect timeout eliminates player while preserving score', () => {
  const room = runningRoom(2);
  const player = room.toRoomState().players[0];
  const internal = room.players.get(player.playerId);
  assert.ok(internal);
  internal.score = 30;
  room.disconnectSocket('socket-1');
  room.tick(Date.now() + GAME_CONFIG.reconnectGraceMs + 1);

  const updated = room.toRoomState().players.find((candidate) => candidate.playerId === player.playerId);
  assert.equal(updated?.gameState, 'eliminated');
  assert.equal(updated?.deathReason, 'disconnectTimeout');
  assert.equal(updated?.score, 30);
});

test('finished room can return to lobby for a clean rematch', () => {
  const room = runningRoom(2);
  const auth = [...room.players.values()][0];
  const player = room.players.get(auth.id);
  assert.ok(player);
  player.score = 40;
  player.eatCount = 4;
  player.deathReason = 'wall';
  room.finish(Date.now() + 5000);

  room.returnToLobby(auth.id, auth.token);

  assert.equal(room.phase, 'lobby');
  assert.equal(room.snakes.size, 0);
  assert.equal(room.foods.length, 0);
  assert.equal(room.latestSnapshot, undefined);
  room.toRoomState().players.forEach((candidate) => {
    assert.equal(candidate.gameState, 'lobby');
    assert.equal(candidate.isReady, false);
    assert.equal(candidate.score, 0);
    assert.equal(candidate.eatCount, 0);
    assert.equal(candidate.deathReason, undefined);
  });
});

test('second game starts with fresh player and board state after rematch', () => {
  const room = runningRoom(2);
  const players = [...room.players.values()];
  const host = players[0];
  const guest = players[1];
  host.score = 50;
  host.eatCount = 5;
  guest.gameState = 'eliminated';
  guest.deathReason = 'wall';
  guest.eliminatedAtTick = 3;
  guest.survivalMs = 1000;
  guest.lastEatTick = 2;
  room.latestSnapshot = room.toSnapshot();
  room.finish(Date.now() + 5000);

  room.returnToLobby(host.id, host.token);
  room.setReady(guest.id, guest.token, true);
  room.startCountdown(host.id, host.token);

  const countdownState = room.toRoomState();
  assert.equal(countdownState.phase, 'countdown');
  countdownState.players.forEach((candidate) => {
    assert.equal(candidate.gameState, 'lobby');
    assert.equal(candidate.score, 0);
    assert.equal(candidate.eatCount, 0);
    assert.equal(candidate.deathReason, undefined);
  });
  assert.equal(room.snakes.size, 0);
  assert.equal(room.foods.length, 0);
  assert.equal(room.latestSnapshot, undefined);

  room.maybeEnterRunning(Date.now() + GAME_CONFIG.countdownMs);

  assert.equal(room.phase, 'running');
  assert.equal(room.snakes.size, 2);
  assert.ok(room.foods.length > 0);
  room.toRoomState().players.forEach((candidate) => {
    assert.equal(candidate.gameState, 'alive');
    assert.equal(candidate.score, 0);
    assert.equal(candidate.eatCount, 0);
    assert.equal(candidate.deathReason, undefined);
  });
});
