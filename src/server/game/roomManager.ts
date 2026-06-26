import { GameRoom } from './room.js';

export class RoomManager {
  private roomsById = new Map<string, GameRoom>();
  private roomIdByCode = new Map<string, string>();

  createRoom(): GameRoom {
    const room = new GameRoom(new Set(this.roomIdByCode.keys()));
    this.roomsById.set(room.id, room);
    this.roomIdByCode.set(room.code, room.id);
    return room;
  }

  getById(roomId: string): GameRoom | undefined {
    return this.roomsById.get(roomId);
  }

  getByCode(code: string): GameRoom | undefined {
    const roomId = this.roomIdByCode.get(code.trim().toUpperCase());
    return roomId ? this.roomsById.get(roomId) : undefined;
  }

  remove(roomId: string): void {
    const room = this.roomsById.get(roomId);
    if (!room) return;
    this.roomsById.delete(roomId);
    this.roomIdByCode.delete(room.code);
  }

  all(): GameRoom[] {
    return [...this.roomsById.values()];
  }
}
