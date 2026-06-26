export const PROTOCOL_VERSION = 1;

export type RoomPhase = 'lobby' | 'countdown' | 'running' | 'finished';
export type Direction = 'up' | 'down' | 'left' | 'right';
export type PlayerConnectionState = 'connected' | 'disconnected';
export type PlayerGameState = 'lobby' | 'alive' | 'eliminated' | 'spectating';
export type DeathReason = 'wall' | 'body' | 'headToHead' | 'disconnectTimeout';
export type GameEventType = 'foodEaten' | 'playerEliminated' | 'matchFinished';

export interface Vec2 {
  x: number;
  y: number;
}

export interface PlayerStats {
  wins: number;
  losses: number;
  gamesPlayed: number;
  winRate: number;
  bestScore: number;
  title: string;
}

export interface PlayerPublicState {
  playerId: string;
  id?: string;
  nickname: string;
  name?: string;
  country: string;
  teamId?: string;
  isHost: boolean;
  isReady: boolean;
  connectionState: PlayerConnectionState;
  gameState: PlayerGameState;
  status?: 'connected' | 'disconnected' | 'ready' | 'alive' | 'eliminated' | 'reconnecting';
  score: number;
  eatCount: number;
  deathReason?: DeathReason;
  survivalMs?: number;
  wins: number;
  losses: number;
  gamesPlayed: number;
  winRate: number;
  bestScore: number;
  title: string;
}

export interface SnakeState {
  playerId: string;
  direction: Direction;
  nextDirection: Direction;
  body: Vec2[];
  segments?: Vec2[];
  pendingGrowth: number;
  alive: boolean;
}

export type FoodType = 'normal' | 'corpse';

export interface FoodState {
  foodId: string;
  id?: string;
  position: Vec2;
  x?: number;
  y?: number;
  type?: FoodType;
  value: number;
  growth: number;
  expiresAt?: number;
  ownerPlayerId?: string;
}

export interface GameEvent {
  type: GameEventType;
  serverTick: number;
  playerIds?: string[];
  playerId?: string;
  foodId?: string;
  deathReason?: DeathReason;
  reason?: DeathReason;
  position?: Vec2;
  x?: number;
  y?: number;
  value?: number;
  foodType?: FoodType;
}

export interface RoomStatePayload {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  roomCode: string;
  roundId: string;
  phase: RoomPhase;
  status: RoomPhase;
  minPlayers: number;
  maxPlayers: number;
  players: PlayerPublicState[];
  ownerId?: string;
  hostId?: string;
  selfId?: string;
  countdownRemainingMs?: number;
  remainingMs?: number;
}

export interface GameSnapshotPayload {
  version: typeof PROTOCOL_VERSION;
  snapshotSeq: number;
  serverTick: number;
  serverTime: number;
  roomId: string;
  roundId: string;
  roomState: RoomPhase;
  status: RoomPhase;
  map: {
    width: number;
    height: number;
  };
  remainingMs: number;
  players: PlayerPublicState[];
  snakes: SnakeState[];
  foods: FoodState[];
  scores?: Array<{
    playerId: string;
    rank: number;
    score: number;
    eaten: number;
    survivalMs: number;
    alive: boolean;
    deathReason?: 'wall' | 'body' | 'headOn' | 'disconnected' | 'unknown';
  }>;
  events: GameEvent[];
}

export interface GameOverPlayerResult {
  playerId: string;
  nickname: string;
  country: string;
  rank: number;
  score: number;
  aliveState: 'alive' | 'eliminated';
  deathReason?: DeathReason;
  eatCount: number;
  survivalMs: number;
  lastEatTick?: number;
  joinOrder: number;
  wins: number;
  losses: number;
  gamesPlayed: number;
  winRate: number;
  bestScore: number;
  title: string;
}

export interface GameOverPayload {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  roundId: string;
  serverTick: number;
  finishedAt: number;
  results: GameOverPlayerResult[];
  rankings?: GameSnapshotPayload['scores'];
  reason?: 'timeUp' | 'lastAlive' | 'hostClosed' | 'unknown';
  serverTime?: number;
}

export interface CreateRoomRequest extends Partial<PlayerStats> {
  nickname: string;
  country: string;
}

export interface JoinRoomRequest extends Partial<PlayerStats> {
  roomCode: string;
  nickname: string;
  country: string;
}

export interface AuthenticatedRoomResponse {
  room: RoomStatePayload;
  playerId: string;
  playerToken: string;
}

export interface SetReadyRequest {
  roomId: string;
  playerId: string;
  playerToken: string;
  ready: boolean;
}

export interface StartGameRequest {
  roomId: string;
  playerId: string;
  playerToken: string;
}

export interface InputRequest {
  roomId: string;
  playerId: string;
  playerToken: string;
  inputSeq: number;
  direction: Direction;
  clientTime: number;
}

export interface ReturnToLobbyRequest {
  roomId: string;
  playerId: string;
  playerToken: string;
}

export interface ReconnectRequest {
  roomId: string;
  playerId: string;
  playerToken: string;
}

export interface LeaveRoomRequest {
  roomId: string;
  playerId: string;
  playerToken: string;
}

export interface LeaveRoomResponse {
  ok: true;
  left: true;
}

export interface ReconnectResponse {
  room: RoomStatePayload;
  latestSnapshot?: GameSnapshotPayload;
}

export interface ErrorPayload {
  ok?: false;
  code: string;
  message: string;
  action?: string;
  step?: number;
}

export interface ClientToServerEvents {
  createRoom: (payload: CreateRoomRequest, ack: (response: AuthenticatedRoomResponse | ErrorPayload) => void) => void;
  joinRoom: (payload: JoinRoomRequest, ack: (response: AuthenticatedRoomResponse | ErrorPayload) => void) => void;
  setReady: (payload: SetReadyRequest, ack: (response: RoomStatePayload | ErrorPayload) => void) => void;
  ready: (payload: { ready: boolean }, ack?: (response: RoomStatePayload | ErrorPayload) => void) => void;
  startGame: (payload: Partial<StartGameRequest> | undefined, ack?: (response: RoomStatePayload | ErrorPayload) => void) => void;
  returnToLobby: (payload: Partial<ReturnToLobbyRequest> | undefined, ack?: (response: RoomStatePayload | ErrorPayload) => void) => void;
  rematch: (payload: Partial<ReturnToLobbyRequest> | undefined, ack?: (response: RoomStatePayload | ErrorPayload) => void) => void;
  input: (payload: InputRequest, ack?: (response: { accepted: boolean } | ErrorPayload) => void) => void;
  leaveRoom: (payload: LeaveRoomRequest, ack?: (response: LeaveRoomResponse | ErrorPayload) => void) => void;
  reconnectPlayer: (payload: ReconnectRequest, ack: (response: ReconnectResponse | ErrorPayload) => void) => void;
  reconnect: (payload: ReconnectRequest, ack?: (response: ReconnectResponse | ErrorPayload) => void) => void;
}

export interface ServerToClientEvents {
  roomState: (payload: RoomStatePayload) => void;
  countdown: (payload: { roomId: string; roundId: string; remainingMs: number; seconds: number; secondsLeft: number; startAt?: number } | number) => void;
  gameSnapshot: (payload: GameSnapshotPayload) => void;
  playerStatus: (payload: PlayerPublicState) => void;
  gameOver: (payload: GameOverPayload) => void;
  errorMessage: (payload: ErrorPayload) => void;
  error: (payload: ErrorPayload) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  roomId?: string;
  playerId?: string;
  playerToken?: string;
}
