import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { registerSocketHandlers, runtimeConfig } from './socket.js';
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from '../shared/protocol.js';

const port = Number(process.env.PORT ?? 3001);
const corsOrigin = process.env.CORS_ORIGIN ?? '*';

const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
  cors: {
    origin: corsOrigin
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'snake-worldcup-network-mvp', runtimeConfig });
});

const frontendDistPath = process.env.FRONTEND_DIST ?? path.resolve(process.cwd(), 'frontend-dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');

if (existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(frontendIndexPath);
  });
} else {
  console.warn(`Frontend dist not found at ${frontendDistPath}; root route will stay unavailable.`);
}

registerSocketHandlers(io);

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Snake Worldcup server listening on :${port}`);
});
