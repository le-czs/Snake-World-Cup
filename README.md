# Snake Worldcup Network MVP

Node.js + TypeScript + Socket.IO server for the room-based multiplayer Snake Worldcup MVP.

## Scripts

- `npm install` - install dependencies.
- `npm run dev` - start the server with hot reload.
- `npm run build` - compile TypeScript to `dist/`.
- `npm start` - run the compiled server.
- `npm test` - run game-loop unit tests.

## Runtime

- Default port: `3001` (`PORT` can override it).
- Health check: `GET /health`.
- Socket.IO path: `/socket.io`.
- CORS origin: `CORS_ORIGIN` or `*` for internal MVP testing.

## Gameplay Constants

- Room size: 2-6 players.
- Map: 40 x 28 cells.
- Tick rate: 12 ticks/sec.
- Movement: every 2 ticks.
- Match length: 120 seconds.
- Reconnect grace: 15 seconds.
- Food count: `players + 2`, clamped from 4 to 8.

## Socket Events

Client-to-server events are typed in `src/shared/protocol.ts`:

- `createRoom`
- `joinRoom`
- `setReady`
- `startGame`
- `input`
- `reconnectPlayer`

Server-to-client events:

- `roomState`
- `countdown`
- `gameSnapshot`
- `playerStatus`
- `gameOver`
- `errorMessage`

## 146 Deployment Notes

A production build can run directly on an internal port for first-round testing:

```bash
npm ci
npm run build
PORT=3001 CORS_ORIGIN='*' npm start
```

For a persistent service, copy this directory to `/opt/snake-worldcup-network-mvp`, install dependencies/build there, then adapt `deploy/snake-worldcup.service` for systemd. If Nginx same-origin proxy is available, adapt `deploy/nginx-snake-worldcup.conf` so frontend static files stay on Nginx while `/socket.io/` upgrades to the Node service.

## Deploy (single source of truth)

The live game runs from a stable location via systemd — **never from an agent
task workdir**. To deploy a change:

```bash
# on the host
git -C /opt/snake-worldcup-network-mvp pull --ff-only
cd /opt/snake-worldcup-network-mvp
npm ci --omit=dev
npm run build            # compiles src/ -> dist/
sudo systemctl restart snake-worldcup.service
# verify
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/socket.io/socket.io.js   # must be 200
```

Live entry: `http://10.110.158.146:3001/`.

## How to contribute (agents & humans)

This repo is the **single source of truth**. Do NOT develop in a private copy.

1. `git clone https://github.com/le-czs/Snake-World-Cup.git`
2. branch off `main`, make your change, build & test locally
3. open a PR against `main`; once merged, deploy from `main` (above)
