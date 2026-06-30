import type { Socket, Server } from 'socket.io';
import { GAME_CONFIG, TICK_MS } from './game/constants.js';
import { RoomManager } from './game/roomManager.js';
import type { ClientToServerEvents, Direction, ErrorPayload, SnakeAppearance, InterServerEvents, ServerToClientEvents, SocketData } from '../shared/protocol.js';

type SnakeIoServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const rooms = new RoomManager();
const error = (message: string, code = 'INVALID_ACTION', step?: number): ErrorPayload => ({ ok: false, code, message, ...(step ? { step } : {}) });
type SnakeSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

class SocketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: string
  ) {
    super(message);
  }
}

export function registerSocketHandlers(io: SnakeIoServer): void {
  setInterval(() => tickRooms(io), TICK_MS);

  io.on('connection', (socket) => {
    console.log('[socket] connected', { socketId: socket.id });

    socket.on('createRoom', (payload, ack) => {
      try {
        const room = rooms.createRoom();
        const normalized = normalizeProfile(payload);
        const auth = room.addPlayer(normalized.nickname, normalized.country, socket.id, normalized.stats, normalized.appearance);
        socket.data.roomId = room.id;
        socket.data.playerId = auth.playerId;
        socket.data.playerToken = auth.playerToken;
        socket.join(room.id);
        const state = room.toRoomState(auth.playerId);
        console.log('[room] createRoom', { roomId: room.id, roomCode: room.code, playerId: auth.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack({ room: state, playerId: auth.playerId, playerToken: auth.playerToken });
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('joinRoom', (payload, ack) => {
      try {
        const room = rooms.getByCode(payload.roomCode);
        if (!room) throw new SocketError('ROOM_NOT_FOUND', 'Room not found', 'joinRoom');
        const normalized = normalizeProfile(payload);
        const auth = room.addPlayer(normalized.nickname, normalized.country, socket.id, normalized.stats, normalized.appearance);
        socket.data.roomId = room.id;
        socket.data.playerId = auth.playerId;
        socket.data.playerToken = auth.playerToken;
        socket.join(room.id);
        const state = room.toRoomState(auth.playerId);
        console.log('[room] joinRoom', { roomId: room.id, roomCode: room.code, playerId: auth.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack({ room: state, playerId: auth.playerId, playerToken: auth.playerToken });
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('setReady', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket, payload);
        const room = requireRoom(resolved.roomId);
        room.setReady(resolved.playerId, resolved.playerToken, payload.ready);
        console.log('[room] ready', { roomId: room.id, playerId: resolved.playerId, ready: payload.ready, roomState: room.phase });
        broadcastRoomState(io, room);
        ack(room.toRoomState(resolved.playerId));
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('startGame', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket, payload ?? {});
        const room = requireRoom(resolved.roomId);
        room.startCountdown(resolved.playerId, resolved.playerToken);
        console.log('[room] startGame', { roomId: room.id, playerId: resolved.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack?.(room.toRoomState(resolved.playerId));
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('input', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket, payload);
        const room = requireRoom(resolved.roomId);
        const direction = normalizeDirection(payload.direction);
        const accepted = room.acceptInput(resolved.playerId, resolved.playerToken, payload.inputSeq, direction);
        ack?.({ accepted });
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('leaveRoom', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket, payload);
        const room = requireRoom(resolved.roomId);
        if (room.phase !== 'lobby' && room.phase !== 'finished') {
          throw new SocketError('GAME_IN_PROGRESS', '对局中暂不可退出', 'leaveRoom');
        }
        room.leavePlayer(resolved.playerId, resolved.playerToken);
        socket.leave(room.id);
        socket.data.roomId = undefined;
        socket.data.playerId = undefined;
        socket.data.playerToken = undefined;
        console.log('[room] leaveRoom', { roomId: room.id, playerId: resolved.playerId, remainingPlayers: room.players.size, roomState: room.phase });
        ack?.({ ok: true, left: true });
        if (room.players.size === 0) {
          rooms.remove(room.id);
          return;
        }
        broadcastRoomState(io, room);
      } catch (err) {
        fail(socket, ack, err, 1);
      }
    });

    socket.on('returnToLobby', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket, payload ?? {});
        const room = requireRoom(resolved.roomId);
        room.returnToLobby(resolved.playerId, resolved.playerToken);
        console.log('[room] returnToLobby', { roomId: room.id, playerId: resolved.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack?.(room.toRoomState(resolved.playerId));
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('rematch', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket, payload ?? {});
        const room = requireRoom(resolved.roomId);
        room.returnToLobby(resolved.playerId, resolved.playerToken);
        console.log('[room] rematch', { roomId: room.id, playerId: resolved.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack?.(room.toRoomState(resolved.playerId));
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('reconnectPlayer', (payload, ack) => {
      try {
        const room = requireRoom(payload.roomId);
        room.reconnect(payload.playerId, payload.playerToken, socket.id);
        socket.data.roomId = room.id;
        socket.data.playerId = payload.playerId;
        socket.data.playerToken = payload.playerToken;
        socket.join(room.id);
        const state = room.toRoomState(payload.playerId);
        console.log('[socket] reconnectPlayer', { roomId: room.id, playerId: payload.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack({ room: state, latestSnapshot: room.latestSnapshot });
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('ready', (payload, ack) => {
      try {
        const resolved = resolveRoomAuth(socket);
        const room = requireRoom(resolved.roomId);
        room.setReady(resolved.playerId, resolved.playerToken, payload.ready);
        console.log('[room] ready', { roomId: room.id, playerId: resolved.playerId, ready: payload.ready, roomState: room.phase });
        broadcastRoomState(io, room);
        ack?.(room.toRoomState(resolved.playerId));
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('reconnect', (payload, ack) => {
      try {
        const room = requireRoom(payload.roomId);
        room.reconnect(payload.playerId, payload.playerToken, socket.id);
        socket.data.roomId = room.id;
        socket.data.playerId = payload.playerId;
        socket.data.playerToken = payload.playerToken;
        socket.join(room.id);
        const state = room.toRoomState(payload.playerId);
        console.log('[socket] reconnect', { roomId: room.id, playerId: payload.playerId, roomState: room.phase });
        broadcastRoomState(io, room);
        ack?.({ room: state, latestSnapshot: room.latestSnapshot });
      } catch (err) {
        fail(socket, ack, err);
      }
    });

    socket.on('disconnect', () => {
      console.log('[socket] disconnected', { socketId: socket.id, roomId: socket.data.roomId, playerId: socket.data.playerId });
      if (!socket.data.roomId) return;
      const room = rooms.getById(socket.data.roomId);
      if (!room) return;
      const player = room.disconnectSocket(socket.id);
      if (player) {
        const state = room.toRoomState(player.id);
        io.to(room.id).emit('playerStatus', state.players.find((candidate) => candidate.playerId === player.id) ?? state.players[0]);
        broadcastRoomState(io, room);
      }
    });
  });
}

function tickRooms(io: SnakeIoServer): void {
  for (const room of rooms.all()) {
    if (room.phase === 'countdown') {
      const remainingMs = room.toRoomState().countdownRemainingMs ?? 0;
      const secondsLeft = Math.max(1, Math.ceil(remainingMs / 1000));
      io.to(room.id).emit('countdown', { roomId: room.id, roundId: room.roundId, remainingMs, seconds: secondsLeft, secondsLeft, startAt: room.countdownStartedAt });
    }

    const previousPhase = room.phase;
    const snapshot = room.tick();
    if (snapshot) {
      console.log('[tick] gameSnapshot', { roomId: room.id, roomState: room.phase, serverTick: snapshot.serverTick });
      for (const event of snapshot.events) {
        if (event.type === 'foodEaten' || event.type === 'corpseEaten' || event.type === 'foodRemoved') {
          io.to(room.id).emit(event.type, event);
        }
      }
      io.to(room.id).emit('gameSnapshot', snapshot);
    }
    if (previousPhase !== 'finished' && room.phase === 'finished') {
      broadcastRoomState(io, room);
      io.to(room.id).emit('gameOver', room.toGameOver());
    }
  }
}

function broadcastRoomState(io: SnakeIoServer, room: ReturnType<RoomManager['createRoom']>): void {
  for (const player of room.players.values()) {
    if (player.socketId) {
      io.to(player.socketId).emit('roomState', room.toRoomState(player.id));
    }
  }
}

function resolveRoomAuth(socket: SnakeSocket, payload?: Partial<{ roomId: string; playerId: string; playerToken: string }>) {
  const roomId = payload?.roomId ?? socket.data.roomId;
  const playerId = payload?.playerId ?? socket.data.playerId;
  const playerToken = payload?.playerToken ?? socket.data.playerToken;
  if (!roomId || !playerId || !playerToken) throw new SocketError('INVALID_ACTION', 'Missing room credentials');
  return { roomId, playerId, playerToken };
}

function normalizeProfile(payload: Partial<{ nickname: string; country: string; name: string; teamId: string; appearance: SnakeAppearance; wins: number; losses: number; gamesPlayed: number; winRate: number; bestScore: number; title: string }>) {
  const country = payload.country ?? payload.teamId ?? payload.appearance?.country ?? 'World';
  return {
    nickname: payload.nickname ?? payload.name ?? 'Player',
    country,
    appearance: normalizeAppearance(payload.appearance, country),
    stats: {
      wins: payload.wins,
      losses: payload.losses,
      gamesPlayed: payload.gamesPlayed,
      winRate: payload.winRate,
      bestScore: payload.bestScore,
      title: payload.title
    }
  };
}


function normalizeAppearance(appearance: SnakeAppearance | undefined, fallbackCountry: string): SnakeAppearance | undefined {
  if (!appearance) return undefined;
  const country = String(appearance.country || fallbackCountry).slice(0, 24) || fallbackCountry;
  return {
    country,
    skinId: String(appearance.skinId || 'classic').slice(0, 32),
    primaryColor: normalizeColor(appearance.primaryColor, '#18A64A'),
    secondaryColor: normalizeColor(appearance.secondaryColor, '#FFD43B'),
    accent: normalizeColor(appearance.accent, '#143b22')
  };
}

function normalizeColor(value: string | undefined, fallback: string): string {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function normalizeDirection(direction: Direction): Direction {
  if (!['up', 'down', 'left', 'right'].includes(direction)) throw new SocketError('INVALID_ACTION', 'Invalid direction');
  return direction;
}

function fail(socket: SnakeSocket, ack: ((response: any) => void) | undefined, err: unknown, stepOverride?: number): void {
  const payload = error(errorMessage(err), errorCode(err), stepOverride ?? errorStep(err));
  if (err instanceof SocketError && err.action) payload.action = err.action;
  ack?.(payload);
  socket.emit('errorMessage', payload);
  socket.emit('error', payload);
  console.warn('[socket] error', { socketId: socket.id, roomId: socket.data.roomId, playerId: socket.data.playerId, code: payload.code, message: payload.message });
}

function requireRoom(roomId: string) {
  const room = rooms.getById(roomId);
  if (!room) throw new SocketError('ROOM_NOT_FOUND', 'Room not found');
  return room;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected server error';
}

function errorCode(err: unknown): string {
  if (err instanceof SocketError) return err.code;
  const message = errorMessage(err);
  if (message.includes('not found')) return 'ROOM_NOT_FOUND';
  if (message.includes('full')) return 'ROOM_FULL';
  if (message.includes('At least')) return 'NOT_READY';
  if (message.includes('non-host players must be ready')) return 'NOT_READY';
  if (message.includes('Readiness can only change')) return 'INVALID_STATE';
  if (message.includes('must be finished')) return 'INVALID_STATE';
  if (message.includes('Game in progress')) return 'GAME_IN_PROGRESS';
  if (message.includes('already started')) return 'GAME_ALREADY_STARTED';
  if (message.includes('Only host')) return 'NOT_OWNER';
  if (message.includes('Invalid player credentials')) return 'RECONNECT_FAILED';
  if (message.includes('Reconnect window expired')) return 'RECONNECT_FAILED';
  if (message.includes('credentials')) return 'INVALID_ACTION';
  return 'INVALID_ACTION';
}

function errorStep(err: unknown): number | undefined {
  if (err instanceof SocketError && err.action === 'leaveRoom') return 1;
  if (errorMessage(err).includes('Game in progress')) return 1;
  return undefined;
}

export const runtimeConfig = {
  reconnectGraceMs: GAME_CONFIG.reconnectGraceMs,
  tickMs: TICK_MS
};
