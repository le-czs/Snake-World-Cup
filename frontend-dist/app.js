const TEAMS = [
  ['bra','巴西','#18A64A','#FFD43B','#143b22'], ['arg','阿根廷','#6EC6FF','#FFFFFF','#1d5d86'],
  ['fra','法国','#2446A6','#F23B3B','#ffffff'], ['eng','英格兰','#FFFFFF','#D92828','#2d5aa7'],
  ['ger','德国','#1E1E1E','#F2C94C','#e54b3b'], ['esp','西班牙','#D7262E','#FFC400','#7a1519'],
  ['por','葡萄牙','#C8192E','#0C8A4B','#f8d348'], ['ned','荷兰','#F47B20','#1F4E9D','#fff1d0']
];
const SKINS = [
  ['classic', '经典球衣'],
  ['lightning', '闪电纹'],
  ['star', '星光纹'],
  ['champion', '冠军金边'],
];
const params = new URLSearchParams(location.search);
const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const state = {
  socket: null,
  roomId: '',
  playerId: '',
  playerToken: '',
  snapshot: null,
  lastSeq: -1,
  connected: false,
  ready: false,
  inputSeq: 0,
  mock: params.get('mock') === '1',
  debug: params.get('debug') === '1',
  eventsSeen: new Set(),
  lastInputAt: 0,
  lastRoom: null,
  lastResults: [],
  lastPlayerScores: new Map(),
  lastRankByPlayer: new Map(),
  lastLeaderId: '',
  lastSfxAt: new Map(),
  removedFoodIds: new Set(),
  isInputLocked: false,
  boostHeld: false,
  currentDirection: 'right',
  boostInputTimer: null,
};
const MAX_EVENT_CHIPS = 3;
const EVENT_CHIP_TTL_MS = 2200;
Object.assign(state, JSON.parse(localStorage.getItem('snake_wc_identity') || '{}'));

TEAMS.forEach(([id, name]) => els.country.add(new Option(name, id)));
SKINS.forEach(([id, name]) => els.skin.add(new Option(name, id)));
els.nickname.value = localStorage.getItem('snake_wc_nickname') || `球员${Math.floor(Math.random() * 900 + 100)}`;
const savedAppearance = JSON.parse(localStorage.getItem('snake_wc_appearance') || '{}');
els.country.value = savedAppearance.country || els.country.value || TEAMS[0][0];
els.skin.value = savedAppearance.skinId || savedAppearance.skin || SKINS[0][0];
state.appearance = makeAppearance(els.country.value, els.skin.value);
els.modeBadge.textContent = state.mock ? 'Mock 预览' : '真实联机';
if (state.debug) els.debugPanel.style.display = 'block';

function show(panel) {
  ['entryPanel', 'lobbyPanel', 'gamePanel', 'resultPanel'].forEach(id => { els[id].hidden = id !== panel; });
}
function status(el, msg) { if (el) el.textContent = msg || ''; }
function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.text ||= button.textContent;
  button.textContent = busy ? '处理中...' : button.dataset.text;
}
function isErrorPayload(ack) {
  return Boolean(ack && (ack.ok === false || ack.success === false || (ack.code && ack.message && !ack.room && !ack.players && !ack.phase)));
}
function normalizeAck(ack) {
  if (!ack) return {};
  if (isErrorPayload(ack)) return { error: ack.error || ack.message || '操作失败' };
  return ack.data || ack;
}
function authPayload(extra = {}) {
  return { roomId: state.roomId, playerId: state.playerId, playerToken: state.playerToken, ...extra };
}
function emit(name, payload = {}, button) {
  if (!state.mock && !state.socket?.connected) {
    showError('未连接服务器，请刷新后重试');
    return;
  }
  setBusy(button, true);
  state.socket.emit(name, payload, ack => {
    setBusy(button, false);
    handleAck(name, ack);
  });
}
function identityPayload() {
  const appearance = currentAppearance();
  return { nickname: els.nickname.value.trim() || '球员', country: appearance.country, appearance };
}
function showError(msg) {
  const text = typeof msg === 'string' ? msg : (msg?.message || '操作失败');
  status(els.entryStatus, text);
  status(els.lobbyStatus, text);
  if (!els.gamePanel.hidden) banner(text, 'error', 1800);
}
function saveIdentity(extra = {}) {
  Object.assign(state, extra);
  saveAppearance();
  localStorage.setItem('snake_wc_identity', JSON.stringify({ roomId: state.roomId, playerId: state.playerId, playerToken: state.playerToken }));
  localStorage.setItem('snake_wc_nickname', els.nickname.value);
}

function teamById(id) { return TEAMS.find(t => t[0] === id) || TEAMS[0]; }
function skinById(id) { return SKINS.find(s => s[0] === id) || SKINS[0]; }
function makeAppearance(country = TEAMS[0][0], skinId = SKINS[0][0]) {
  const team = teamById(country);
  return { country: team[0], skinId: skinById(skinId)[0], primaryColor: team[2], secondaryColor: team[3], accent: team[4] || team[3] };
}
function currentAppearance() {
  state.appearance = makeAppearance(els.country.value, els.skin.value);
  return state.appearance;
}
function saveAppearance() {
  const appearance = currentAppearance();
  localStorage.setItem('snake_wc_appearance', JSON.stringify(appearance));
  return appearance;
}
function normalizeAppearance(source = {}) {
  const nested = source.appearance || {};
  const country = nested.country || source.country || source.countrySkin || source.teamId || state.appearance?.country || TEAMS[0][0];
  const skinId = nested.skinId || source.skinId || SKINS[0][0];
  return { ...makeAppearance(country, skinId), ...nested, country, skinId: skinById(skinId)[0] };
}
function playerKey(p = {}) { return p.playerId || p.id || p.socketId || p.userId || ''; }
function findPlayerById(id) {
  if (!id) return null;
  const pools = [state.snapshot?.players || [], state.lastRoom?.players || [], state.lastResults || []];
  for (const players of pools) {
    const found = players.find(p => playerKey(p) === id);
    if (found) return found;
  }
  return null;
}
function appearanceOf(source = {}) {
  const owner = findPlayerById(playerKey(source));
  const merged = { ...(owner || {}), ...source, appearance: source.appearance || owner?.appearance };
  if (playerKey(merged) && playerKey(merged) === state.playerId) return normalizeAppearance({ ...merged, appearance: merged.appearance || state.appearance });
  return normalizeAppearance(merged);
}
function teamName(id) { return teamById(id)[1]; }
function skinName(id) { return skinById(id)[1]; }
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function miniSnakeHtml(source = {}, className = '') {
  const a = appearanceOf(source);
  const vars = `--snake-primary:${a.primaryColor};--snake-secondary:${a.secondaryColor};--snake-accent:${a.accent}`;
  return `<span class="snake-mini ${className} skin-${a.skinId}" style="${vars}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
}
function titleForResult(rank) { return rank === 1 ? '冠军候选' : '称号待解锁'; }
function updateEntryPreview(feedback = '已同步') {
  const a = saveAppearance();
  els.previewName.textContent = els.nickname.value.trim() || '球员';
  els.previewCountry.textContent = teamName(a.country);
  els.previewSkin.textContent = skinName(a.skinId);
  els.previewFeedback.textContent = feedback;
  els.previewCard.style.setProperty('--snake-primary', a.primaryColor);
  els.previewCard.style.setProperty('--snake-secondary', a.secondaryColor);
  els.previewCard.style.setProperty('--snake-accent', a.accent);
  drawEntryPreview(a, feedback);
}
function drawEntryPreview(a, feedback = '') {
  const canvas = els.entryPreview;
  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0d6b3b'; c.fillRect(0, 0, w, h);
  c.fillStyle = 'rgba(255,255,255,.08)';
  for (let x = 0; x < w; x += 36) c.fillRect(x, 0, 18, h);
  c.strokeStyle = 'rgba(255,255,255,.72)'; c.lineWidth = 4; c.strokeRect(16, 16, w - 32, h - 32);
  [{x:230,y:72},{x:190,y:78},{x:150,y:96},{x:110,y:110},{x:72,y:110}].forEach((pt, i) => drawPreviewSegment(c, pt.x, pt.y, 38, a, i));
  c.fillStyle = '#fff'; c.font = '900 18px sans-serif'; c.textAlign = 'center';
  c.fillText(`${teamName(a.country)} · ${skinName(a.skinId)}`, w / 2, h - 22);
}
function drawPreviewSegment(c, cx, cy, size, a, index) {
  const head = index === 0;
  c.save(); c.translate(cx, cy);
  c.fillStyle = head ? a.secondaryColor : a.primaryColor; c.strokeStyle = head ? a.primaryColor : a.secondaryColor; c.lineWidth = head ? 4 : 3;
  c.beginPath(); c.roundRect ? c.roundRect(-size/2, -size/2, size, size, 12) : c.rect(-size/2, -size/2, size, size); c.fill(); c.stroke();
  if (a.skinId === 'lightning') { c.strokeStyle = a.accent; c.lineWidth = 4; c.beginPath(); c.moveTo(-10,-8); c.lineTo(2,-2); c.lineTo(-3,10); c.lineTo(12,2); c.stroke(); }
  if (a.skinId === 'star') { c.fillStyle = a.secondaryColor; c.beginPath(); c.arc(-5,-5,4,0,Math.PI*2); c.arc(8,7,3,0,Math.PI*2); c.fill(); }
  if (a.skinId === 'champion') { c.strokeStyle = '#ffd43b'; c.lineWidth = 5; c.strokeRect(-size*.34,-size*.34,size*.68,size*.68); }
  if (head) { c.fillStyle = '#10251c'; c.beginPath(); c.arc(7,-8,3,0,Math.PI*2); c.arc(7,8,3,0,Math.PI*2); c.fill(); }
  c.restore();
}
function randomizeAppearance() {
  const team = TEAMS[Math.floor(Math.random() * TEAMS.length)];
  const skin = SKINS[Math.floor(Math.random() * SKINS.length)];
  els.country.value = team[0];
  els.skin.value = skin[0];
  updateEntryPreview('已随机换装');
  status(els.entryStatus, `已随机为 ${team[1]} · ${skin[1]}`);
}

function connect() {
  if (state.mock) {
    status(els.entryStatus, 'Mock 模式：仅用于视觉预览，不参与联网验收');
    return startMock();
  }
  state.socket = io({ path: '/socket.io/', transports: ['polling'] });
  state.socket.on('connect', () => {
    state.connected = true;
    status(els.entryStatus, '已连接服务器');
    status(els.lobbyStatus, state.roomId ? '已重新连接服务器' : '');
    els.netText.textContent = '流畅';
    if (state.roomId && state.playerId && state.playerToken) reconnect();
  });
  state.socket.on('connect_error', err => {
    state.connected = false;
    els.netText.textContent = '连接失败';
    showError(`连接失败：${err?.message || '请检查服务'}`);
  });
  state.socket.on('disconnect', () => {
    state.connected = false;
    els.netText.textContent = '重连中';
    status(els.entryStatus, '连接已断开，正在重连');
    status(els.lobbyStatus, '连接已断开，正在重连');
    banner('连接波动，正在重连');
  });
  state.socket.on('roomState', renderRoom);
  state.socket.on('countdown', data => {
    show('gamePanel');
    const remaining = Math.ceil((data?.remainingMs ?? 0) / 1000);
    const text = remaining > 0 ? remaining : '开球！';
    banner(`${text}\n准备抢球`, 'countdown', remaining > 0 ? 860 : 1200);
    cueSfx(remaining > 0 ? 'countdown' : 'kickoff', { channel: 'commentary' });
  });
  state.socket.on('gameSnapshot', renderSnapshot);
  state.socket.on('playerStatus', data => {
    if (data?.playerId === state.playerId && isEliminated(data)) {
      eliminateFeedback(data.deathReason);
      logEvent(`你已淘汰：${reasonText(data.deathReason)}`);
    }
  });
  state.socket.on('playerEliminated', data => renderEvent({ type: 'playerEliminated', ...data }));
  state.socket.on('eat', data => renderEvent({ type: 'eat', ...data }));
  state.socket.on('foodEaten', data => handleFoodConsumed({ type: 'foodEaten', ...data }));
  state.socket.on('corpseEaten', data => handleFoodConsumed({ type: 'corpseEaten', foodType: 'corpse', value: 5, ...data }));
  state.socket.on('foodRemoved', data => removeFoods(data?.removedFoodIds || data?.foodIds || (data?.foodId ? [data.foodId] : [])));
  state.socket.on('leadChanged', data => renderEvent({ type: 'leadChanged', ...data }));
  state.socket.on('gameOver', renderGameOver);
  state.socket.on('rematch', renderRoom);
  state.socket.on('returnToLobby', renderRoom);
  state.socket.on('error', err => showError(err?.message || String(err || '服务器错误')));
  state.socket.on('errorMessage', err => showError(err?.message || String(err || '服务器错误')));
}
function handleAck(name, ack) {
  const data = normalizeAck(ack);
  if (data.error) {
    showError(data.error);
    return;
  }
  if (data.roomId || data.playerId || data.playerToken) saveIdentity(data);
  if (data.room) renderRoom(data.room);
  if (data.roomState || data.players || data.phase) renderRoom(data);
  if (data.latestSnapshot) renderSnapshot(data.latestSnapshot);
  if (name === 'createRoom' || name === 'joinRoom') status(els.lobbyStatus, '进入房间成功，等待准备');
  if (name === 'rematch' || name === 'returnToLobby') status(els.lobbyStatus, '已回到房间，等待重新准备');
  if (name === 'startGame' && data.phase === 'lobby') status(els.lobbyStatus, '已回到房间，等待重新准备');
}
function reconnect() {
  emit('reconnectPlayer', { roomId: state.roomId, playerId: state.playerId, playerToken: state.playerToken });
}

els.country.onchange = () => updateEntryPreview();
els.skin.onchange = () => updateEntryPreview();
els.nickname.oninput = () => updateEntryPreview();
els.randomizeBtn.onclick = randomizeAppearance;
updateEntryPreview();
els.createBtn.onclick = () => emit('createRoom', identityPayload(), els.createBtn);
els.showJoinBtn.onclick = () => { els.joinRow.hidden = !els.joinRow.hidden; };
els.joinBtn.onclick = () => emit('joinRoom', { roomCode: els.roomCode.value.trim().toUpperCase(), ...identityPayload() }, els.joinBtn);
els.readyBtn.onclick = () => emit('setReady', authPayload({ ready: !state.ready }), els.readyBtn);
els.startBtn.onclick = () => {
  const reason = els.startBtn.dataset.reason;
  if (reason) { status(els.lobbyStatus, reason); return; }
  emit('startGame', authPayload(), els.startBtn);
};
els.copyRoomBtn.onclick = async () => {
  const text = els.roomIdText.textContent || state.roomId;
  if (!text || text === '--') {
    showError('当前还没有房间号');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      status(els.lobbyStatus, `已复制房间号：${text}`);
      return;
    }
  } catch (_err) {
    // fall through to legacy copy path
  }
  const temp = document.createElement('textarea');
  temp.value = text;
  temp.setAttribute('readonly', 'readonly');
  temp.style.position = 'fixed';
  temp.style.left = '-9999px';
  document.body.appendChild(temp);
  temp.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(temp);
  status(els.lobbyStatus, copied ? `已复制房间号：${text}` : '复制失败，请手动选中房间号');
};
els.againBtn.onclick = () => rematch();
els.homeBtn.onclick = () => returnToLobby();
els.exitRoomBtn.onclick = () => leaveRoom();
els.exitRoomResultBtn.onclick = () => leaveRoom();
const keyMap = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
document.addEventListener('keydown', e => {
  if (keyMap[e.code]) { e.preventDefault(); sendInput(keyMap[e.code]); }
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setBoostHeld(true); }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') { e.preventDefault(); setBoostHeld(false); }
});
document.querySelectorAll('[data-dir]').forEach(b => b.onclick = () => sendInput(b.dataset.dir));
if (els.boostBtn) {
  els.boostBtn.onpointerdown = e => { e.preventDefault(); setBoostHeld(true); };
  els.boostBtn.onpointerup = e => { e.preventDefault(); setBoostHeld(false); };
  els.boostBtn.onpointercancel = () => setBoostHeld(false);
  els.boostBtn.onpointerleave = () => setBoostHeld(false);
}
function setBoostHeld(active) {
  if (state.isInputLocked) active = false;
  if (state.boostHeld === active) return;
  state.boostHeld = active;
  els.gamePanel.classList.toggle('boost-held', state.boostHeld);
  sendInput(state.currentDirection, true);
  clearInterval(state.boostInputTimer);
  state.boostInputTimer = state.boostHeld ? setInterval(() => sendInput(state.currentDirection, true), 180) : null;
}
function sendInput(direction, force = false) {
  if (state.isInputLocked) return;
  state.currentDirection = direction || state.currentDirection;
  const now = Date.now();
  if (!force && now - state.lastInputAt < 70) return;
  state.lastInputAt = now;
  emit('input', authPayload({ inputSeq: ++state.inputSeq, direction: state.currentDirection, boost: state.boostHeld, clientTime: now }));
}

function resetRoundView() {
  state.snapshot = null;
  state.lastSeq = -1;
  state.inputSeq = 0;
  state.lastInputAt = 0;
  state.boostHeld = false;
  state.currentDirection = 'right';
  clearInterval(state.boostInputTimer);
  state.boostInputTimer = null;
  state.lastResults = [];
  state.lastPlayerScores = new Map();
  state.lastRankByPlayer = new Map();
  state.lastLeaderId = '';
  state.eventsSeen = new Set();
  state.removedFoodIds = new Set();
  els.resultList.innerHTML = '';
  els.eventLog.innerHTML = '';
  els.keyMoments.hidden = true;
  els.keyMoments.innerHTML = '';
  if (els.resultHero) els.resultHero.innerHTML = '<span>FINAL WHISTLE</span><strong>冠军待定</strong><small>等待服务端结算</small>';
  els.leaderboard.innerHTML = '';
  els.meText.textContent = '0 分 · 0 球 · 对战中';
  els.timeText.textContent = '02:00';
  els.spectatorNotice.hidden = true;
  els.gamePanel.classList.remove('spectating', 'danger-flash', 'boost-held');
  updateInputLock(false);
  els.banner.hidden = true;
  els.banner.className = 'center-banner';
  if (state.debug) els.debugPanel.textContent = `seq --\ntick --\nroom ${state.roomId || '--'}`;
}
function renderRoom(room = {}) {
  const previousPhase = state.lastRoom?.phase || state.lastRoom?.roomState;
  state.lastRoom = room;
  state.roomId = room.roomId || room.id || state.roomId;
  const phase = room.phase || room.roomState;
  const players = room.players || [];
  const lobbyIsClean = phase === 'lobby' && players.every(p => !isEliminated(p) && (p.score || 0) === 0 && (p.eatCount || 0) === 0 && !p.deathReason);
  if (phase === 'countdown' || (phase === 'lobby' && (previousPhase === 'finished' || previousPhase === 'running' || lobbyIsClean))) resetRoundView();
  if (phase === 'countdown' || phase === 'running') show('gamePanel'); else show('lobbyPanel');
  els.roomIdText.textContent = room.roomCode || state.roomId || '--';
  els.playerList.innerHTML = players.map(p => playerHtml(p)).join('') || '<p class="hint">等待玩家加入...</p>';
  const me = players.find(p => p.playerId === state.playerId || p.id === state.playerId);
  state.ready = Boolean(me?.isReady ?? me?.ready);
  els.readyBtn.textContent = state.ready ? '取消准备' : '准备';
  updateLobbyControls(room, players, me);
}
function playerHtml(p) {
  const a = appearanceOf(p);
  const connected = (p.connectionState || (p.connected === false ? 'disconnected' : 'connected')) === 'connected';
  const ready = Boolean(p.isReady ?? p.ready);
  const host = p.isHost ? '<span class="host-crown" title="房主">♛</span>' : '';
  const stateText = `${ready ? '已准备' : '未准备'}${connected ? '' : ' · 掉线'}${isEliminated(p) ? ' · 红牌' : ''}`;
  const name = escapeHtml(p.nickname || p.name || p.playerId || p.id || '球员');
  return `<div class="player appearance-player" style="--team:${a.primaryColor};--snake-primary:${a.primaryColor};--snake-secondary:${a.secondaryColor};--snake-accent:${a.accent}">${miniSnakeHtml(p, 'lobby-snake')}<span>${host}<b>${name}</b><small>${teamName(a.country)} · ${skinName(a.skinId)}</small></span><strong>${stateText}</strong></div>`;
}
function updateLobbyControls(room = {}, players = [], me) {
  const phase = room.phase || room.roomState || 'lobby';
  const minPlayers = room.minPlayers || 2;
  const maxPlayers = room.maxPlayers || 6;
  const nonHostReady = players.filter(p => !p.isHost).every(p => Boolean(p.isReady ?? p.ready));
  const isHost = Boolean(me?.isHost);
  let reason = '';
  if (!isHost) reason = '只有房主可以开始比赛';
  else if (phase !== 'lobby') reason = '比赛已经开始';
  else if (players.length < minPlayers) reason = `至少需要 ${minPlayers} 名玩家`;
  else if (!nonHostReady) reason = '等待所有非房主玩家准备';
  els.startBtn.disabled = Boolean(reason);
  els.startBtn.dataset.reason = reason;
  els.readyBtn.disabled = phase !== 'lobby';
  status(els.lobbyStatus, phase === 'countdown' ? '即将开球...' : `房间 ${room.roomCode || state.roomId || '--'} · ${players.length}/${maxPlayers}${reason ? ' · ' + reason : ' · 可以开始'}`);
}
function renderSnapshot(snap = {}) {
  const seq = snap.snapshotSeq ?? snap.serverTick ?? 0;
  if (seq < state.lastSeq) {
    const newRoundStarted = (snap.serverTick ?? seq) <= 2 && (snap.roomState || snap.status) === 'running';
    if (!newRoundStarted) return;
    resetRoundView();
  }
  state.lastSeq = seq;
  if (state.snapshot?.roundId && snap.roundId && state.snapshot.roundId !== snap.roundId) {
    state.removedFoodIds.clear();
  }
  state.snapshot = snap;
  reconcileRemovedFoods(snap);
  show('gamePanel');
  els.timeText.textContent = fmtTime(snap.remainingMs ?? snap.timeLeft ?? 0);
  draw(snap);
  const players = snap.players || [];
  const scores = snap.scores || [];
  detectScoreAndRankChanges(players.length ? players : scores);
  renderLeaderboard(players.length ? players : scores);
  const mine = players.find(p => p.playerId === state.playerId || p.id === state.playerId);
  if (mine) {
    const mineRank = rankForPlayer(state.playerId, players, scores);
    els.meText.textContent = `${mine.score || 0} 分 · ${mine.eatCount || 0} 球 · ${isEliminated(mine) ? '已淘汰' : '对战中'}`;
    updateSpectatorState(mine, mineRank);
  } else {
    updateSpectatorState(null);
  }
  (snap.events || []).forEach(renderEvent);
  if (state.debug) els.debugPanel.textContent = `seq ${snap.snapshotSeq ?? '--'}\ntick ${snap.serverTick ?? '--'}\nroom ${state.roomId || '--'}`;
}
function handleFoodConsumed(ev = {}) {
  if (ev.foodId) removeFoods([ev.foodId]);
  renderEvent(ev);
}
function removeFoods(foodIds = []) {
  const ids = foodIds.filter(Boolean);
  if (!ids.length) return;
  ids.forEach(id => state.removedFoodIds.add(id));
  if (state.snapshot?.foods) {
    state.snapshot.foods = state.snapshot.foods.filter(food => !state.removedFoodIds.has(food.foodId || food.id));
    draw(state.snapshot);
  }
}
function reconcileRemovedFoods(snap = {}) {
  if (!state.removedFoodIds.size) return;
  snap.foods = (snap.foods || []).filter(food => !state.removedFoodIds.has(food.foodId || food.id));
}
function renderEvent(ev = {}) {
  const key = `${ev.type}-${ev.playerId || ''}-${(ev.playerIds || []).join('.')}-${ev.foodId || ''}-${ev.tick || ev.serverTick || ''}-${ev.reason || ev.deathReason || ''}`;
  if (state.eventsSeen.has(key)) return;
  state.eventsSeen.add(key);
  const playerIds = ev.playerIds || (ev.playerId ? [ev.playerId] : []);
  const isMine = playerIds.includes(state.playerId);
  if (ev.type === 'eliminated' || ev.type === 'playerEliminated') {
    const reason = ev.reason || ev.deathReason;
    const deadName = playerName(ev.playerId || playerIds[0]);
    const text = `${isMine ? '你' : deadName}红牌：${reasonText(reason)}`;
    logEvent(text, 'danger');
    cueSfx(isMine ? 'eliminated' : 'red-card', { channel: 'commentary' });
    if (isMine) eliminateFeedback(reason);
    else subtleMatchPulse('danger');
  }
  if (ev.type === 'foodRemoved') {
    removeFoods(ev.removedFoodIds || ev.foodIds || (ev.foodId ? [ev.foodId] : []));
    return;
  }
  if (ev.type === 'eat' || ev.type === 'foodEaten' || ev.type === 'corpseEaten') {
    if (ev.foodId) removeFoods([ev.foodId]);
    const value = ev.value ?? (ev.foodType === 'corpse' ? 5 : 10);
    const isCorpse = ev.foodType === 'corpse' || ev.type === 'corpseEaten';
    const label = isCorpse ? '尸体球' : '足球';
    const eaterName = playerName(ev.playerId || playerIds[0]);
    if (!isCorpse) logEvent(`${isMine ? '你' : eaterName}吃到${label} +${value}`, 'score');
    scorePopAtGrid(ev.position || ev.foodPosition || ev.headPosition, value, isCorpse ? 'corpse' : 'normal');
    if (isCorpse) corpseClaimFeedback(ev, isMine, eaterName, value);
    else cueSfx('eat');
  }
  if (ev.type === 'leadChanged') {
    const leaderId = ev.playerId || ev.leaderId || ev.playerIds?.[0];
    if (leaderId) announceLeader(leaderId, ev.previousLeaderId);
  }
  if (ev.type === 'gameOver' || ev.type === 'matchFinished') {
    banner('比赛结束', 'finish', 1800);
    cueSfx('finish', { channel: 'commentary' });
  }
}
function renderLeaderboard(players = []) {
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  els.leaderboard.innerHTML = sorted.slice(0, 6).map((p, i) => {
    const id = p.playerId || p.id;
    const previousRank = state.lastRankByPlayer.get(id);
    const movedUp = previousRank && previousRank > i + 1;
    const cls = `rank-row ${isEliminated(p) ? 'eliminated' : ''} ${movedUp ? 'rank-up' : ''}`;
    return `<div class="${cls}"><span class="dot" style="--team:${teamColor(p.country || p.countrySkin || p.teamId)}"></span><span>${i + 1}. ${p.nickname || p.name || p.playerId || p.id}</span><b>${p.score || 0}</b></div>`;
  }).join('');
  state.lastRankByPlayer = new Map(sorted.map((p, i) => [p.playerId || p.id, i + 1]));
}
function detectScoreAndRankChanges(players = []) {
  if (!players.length) return;
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const leader = sorted[0];
  const leaderId = leader?.playerId || leader?.id;
  if (leaderId && state.lastLeaderId && leaderId !== state.lastLeaderId) announceLeader(leaderId, state.lastLeaderId);
  if (leaderId) state.lastLeaderId = leaderId;
  players.forEach(p => {
    const id = p.playerId || p.id;
    const nextScore = p.score || 0;
    const previousScore = state.lastPlayerScores.get(id);
    if (previousScore !== undefined && nextScore > previousScore) {
      const delta = nextScore - previousScore;
      logEvent(`${id === state.playerId ? '你' : playerName(id)}分数 +${delta}`, delta === 5 ? 'corpse' : 'score');
      if (id === state.playerId) scorePopAtGrid(null, delta, delta === 5 ? 'corpse' : 'normal');
    }
    state.lastPlayerScores.set(id, nextScore);
  });
}
function announceLeader(leaderId, previousLeaderId) {
  if (!leaderId || leaderId === previousLeaderId) return;
  const name = playerName(leaderId);
  const mine = leaderId === state.playerId;
  logEvent(`${mine ? '你' : name}冲到第一！`, 'lead');
  subtleMatchPulse('lead');
  cueSfx('lead', { channel: 'commentary' });
}
function renderGameOver(data = {}) {
  show('resultPanel');
  state.lastResults = data.results || data.rankings || [];
  const rows = [...state.lastResults].sort((a, b) => (a.rank || 99) - (b.rank || 99));
  const winner = rows[0];
  if (els.resultHero && winner) {
    els.resultHero.innerHTML = `<span>FINAL WHISTLE</span><strong>${winner.nickname || winner.name || winner.playerId} 夺冠</strong><small>${winner.score || 0} 分 · ${winner.aliveState === 'alive' || winner.alive ? '存活到终场' : '积分制胜'}</small>`;
  }
  els.resultList.innerHTML = rows.map((r, i) => {
    const rank = r.rank || i + 1;
    const mine = r.playerId === state.playerId || r.id === state.playerId;
    const cls = `result-row ${rank === 1 ? 'winner' : ''} ${mine ? 'mine' : ''}`;
    const outcome = reasonText(r.deathReason) || (r.aliveState === 'alive' || r.alive ? '存活到最后' : '淘汰');
    const name = escapeHtml(r.nickname || r.name || r.playerId || '球员');
    const a = appearanceOf(r);
    const title = r.title && r.title !== '新秀' ? r.title : titleForResult(rank);
    return `<div class="${cls}"><b>${rank === 1 ? '🏆' : '#'+rank}</b>${miniSnakeHtml(r, 'result-snake')}<span>${name}<br><small>${outcome} · 吃球 ${r.eatCount ?? r.eaten ?? '--'} · ${Math.round((r.survivalMs || 0) / 1000)}s</small><em>${title} · ${teamName(a.country)} ${skinName(a.skinId)} · 胜负统计预留</em></span><strong>${r.score || 0}</strong></div>`;
  }).join('') || '<p>暂无结算数据</p>';
  renderKeyMoments(data.keyMoments || data.moments || [], rows);
  updateReplayControls();
  banner(winner ? `🏆 ${winner.nickname || winner.name || '冠军'}\n${winner.score || 0} 分封王` : '比赛结束', 'finish', 2200);
  cueSfx('champion', { channel: 'commentary' });
}
function leaveRoom() {
  const oldSocket = state.socket;
  if (oldSocket) {
    oldSocket.removeAllListeners();
    oldSocket.disconnect();
  }
  state.socket = null;
  state.connected = false;
  state.roomId = '';
  state.playerId = '';
  state.playerToken = '';
  state.snapshot = null;
  state.lastSeq = -1;
  state.ready = false;
  state.inputSeq = 0;
  state.lastInputAt = 0;
  state.boostHeld = false;
  state.currentDirection = 'right';
  clearInterval(state.boostInputTimer);
  state.boostInputTimer = null;
  state.lastRoom = null;
  state.lastResults = [];
  state.lastPlayerScores = new Map();
  state.lastRankByPlayer = new Map();
  state.lastLeaderId = '';
  state.eventsSeen = new Set();
  state.removedFoodIds = new Set();
  localStorage.removeItem('snake_wc_identity');
  els.roomIdText.textContent = '--';
  els.playerList.innerHTML = '';
  els.resultList.innerHTML = '';
  els.eventLog.innerHTML = '';
  els.keyMoments.hidden = true;
  els.keyMoments.innerHTML = '';
  els.meText.textContent = '0 分 · 第 --';
  els.timeText.textContent = '02:00';
  els.netText.textContent = '未连接';
  els.debugPanel.textContent = '';
  els.spectatorNotice.hidden = true;
  updateInputLock(false);
  els.gamePanel.classList.remove('boost-held');
  els.banner.hidden = true;
  show('entryPanel');
  status(els.entryStatus, '已退出房间，可以重新创建或加入');
  status(els.lobbyStatus, '');
  status(els.resultStatus, '');
  connect();
}
function rematch() {
  const me = getMeFromRoom();
  if (!me?.isHost) {
    status(els.resultStatus, '等待房主再开；你可以先返回房间准备下一局。');
    returnToLobby();
    return;
  }
  emit('rematch', authPayload(), els.againBtn);
}
function returnToLobby() {
  emit('returnToLobby', authPayload(), els.homeBtn);
}
function updateReplayControls() {
  const me = getMeFromRoom();
  const isHost = Boolean(me?.isHost);
  els.againBtn.textContent = isHost ? '再来一局' : '返回房间';
  els.homeBtn.textContent = '返回房间';
  status(els.resultStatus, isHost ? '房主可重开同一房间；其他玩家回房后重新准备。' : '等待房主再开；先返回房间查看玩家状态。');
}
function getMeFromRoom() {
  const players = state.lastRoom?.players || [];
  return players.find(p => p.playerId === state.playerId || p.id === state.playerId);
}
function banner(text, kind = '', duration = 1600) {
  els.banner.hidden = false;
  els.banner.className = `center-banner ${kind}`.trim();
  els.banner.textContent = text;
  clearTimeout(banner.t);
  banner.t = setTimeout(() => { els.banner.hidden = true; els.banner.className = 'center-banner'; }, duration);
}
function eliminateFeedback(reason) {
  const text = `🟥 ${reasonText(reason)}淘汰`;
  banner(text, 'eliminated', 1500);
  els.gamePanel.classList.add('danger-flash');
  clearTimeout(eliminateFeedback.t);
  eliminateFeedback.t = setTimeout(() => els.gamePanel.classList.remove('danger-flash'), 800);
}
function updateSpectatorState(player, rank) {
  const eliminated = Boolean(player && isEliminated(player));
  els.gamePanel.classList.toggle('spectating', eliminated);
  updateInputLock(eliminated);
  els.spectatorNotice.hidden = !eliminated;
  if (eliminated) {
    const rankText = rank ? `暂列第 ${rank}` : '等待排名';
    els.spectatorNotice.textContent = `已淘汰，最终分数 ${player.score || 0}，${rankText}，等待本局结算`;
  }
}
function updateInputLock(locked) {
  state.isInputLocked = Boolean(locked);
  if (state.isInputLocked) setBoostHeld(false);
  els.gamePanel.classList.toggle('input-locked', state.isInputLocked);
  document.querySelectorAll('[data-dir]').forEach(button => { button.disabled = state.isInputLocked; });
}
function rankForPlayer(playerId, players = [], scores = []) {
  const direct = [...scores, ...players].find(p => (p.playerId || p.id) === playerId && p.rank);
  if (direct) return direct.rank;
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const index = sorted.findIndex(p => (p.playerId || p.id) === playerId);
  return index >= 0 ? index + 1 : null;
}
function scorePopAtGrid(pos, value = 10, kind = 'normal') {
  const pop = document.createElement('div');
  pop.className = `score-pop ${kind}`;
  pop.textContent = `+${value}`;
  const rect = els.field.getBoundingClientRect();
  if (pos) {
    const p = point(pos);
    pop.style.left = `${rect.left + ((p.x + .5) / 40) * rect.width}px`;
    pop.style.top = `${rect.top + ((p.y + .5) / 28) * rect.height}px`;
  } else {
    pop.style.left = `${rect.left + rect.width / 2}px`;
    pop.style.top = `${rect.top + rect.height / 2}px`;
  }
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 760);
}
function logEvent(text, kind = '') {
  const existing = [...els.eventLog.children].find(chip => chip.dataset.text === text && chip.dataset.kind === kind);
  if (existing) {
    existing.classList.remove('bump');
    void existing.offsetWidth;
    existing.classList.add('bump');
    clearTimeout(existing.removeTimer);
    existing.removeTimer = setTimeout(() => existing.remove(), EVENT_CHIP_TTL_MS);
    return;
  }
  const chip = document.createElement('div');
  chip.className = `event-chip ${kind}`.trim();
  chip.dataset.text = text;
  chip.dataset.kind = kind;
  chip.textContent = text;
  els.eventLog.prepend(chip);
  [...els.eventLog.children].slice(MAX_EVENT_CHIPS).forEach(node => node.remove());
  chip.removeTimer = setTimeout(() => chip.remove(), EVENT_CHIP_TTL_MS);
}
function subtleMatchPulse(kind = '') {
  els.gamePanel.classList.remove('feed-pulse', 'feed-pulse-lead', 'feed-pulse-danger');
  void els.gamePanel.offsetWidth;
  els.gamePanel.classList.add('feed-pulse');
  if (kind === 'lead') els.gamePanel.classList.add('feed-pulse-lead');
  if (kind === 'danger') els.gamePanel.classList.add('feed-pulse-danger');
  clearTimeout(subtleMatchPulse.t);
  subtleMatchPulse.t = setTimeout(() => els.gamePanel.classList.remove('feed-pulse', 'feed-pulse-lead', 'feed-pulse-danger'), 520);
}
function corpseClaimFeedback(ev, isMine, eaterName, value) {
  const ownerId = ev.ownerPlayerId || ev.deadPlayerId || ev.victimPlayerId;
  const ownedByMe = ownerId === state.playerId;
  const title = isMine ? `你抢到尸体球 +${value}` : ownedByMe ? `你的尸体被抢 +${value}` : `${eaterName} 抢到尸体 +${value}`;
  logEvent(`${title} · 不增长`, 'corpse');
  subtleMatchPulse('corpse');
  cueSfx('corpse', { channel: 'commentary' });
}
function renderKeyMoments(moments = [], rows = []) {
  const fallback = rows.slice(0, 3).map(r => ({ label: `${r.rank || ''} ${r.nickname || r.name || r.playerId}`, detail: `${r.score || 0} 分 · ${reasonText(r.deathReason) || '存活争冠'}` }));
  const list = moments.length ? moments : fallback;
  els.keyMoments.hidden = !list.length;
  els.keyMoments.innerHTML = list.length ? `<strong>KEY MOMENTS</strong>${list.slice(0, 4).map(item => `<span>${item.label || item.title || momentText(item)}<small>${item.detail || item.description || ''}</small></span>`).join('')}` : '';
}
function momentText(item = {}) {
  if (typeof item === 'string') return item;
  if (item.type === 'foodEaten' || item.type === 'corpseEaten') return `${playerName(item.playerId)} +${item.value || 5}`;
  if (item.type === 'playerEliminated') return `${playerName(item.playerId)} ${reasonText(item.reason || item.deathReason)}淘汰`;
  return item.type || '关键回合';
}
function playerName(id) {
  if (!id) return '玩家';
  const pools = [state.snapshot?.players || [], state.lastRoom?.players || [], state.lastResults || []];
  for (const players of pools) {
    const player = players.find(p => (p.playerId || p.id) === id);
    if (player) return player.nickname || player.name || id;
  }
  return id;
}
function cueSfx(name, options = {}) {
  if (!name) return;
  const now = Date.now();
  const key = `${options.channel || 'sfx'}:${name}`;
  if (now - (state.lastSfxAt.get(key) || 0) < 180) return;
  state.lastSfxAt.set(key, now);
  if (typeof window.playSfx === 'function') window.playSfx(name, options);
}
function isEliminated(p = {}) { return p.gameState === 'eliminated' || p.aliveState === 'eliminated' || p.alive === false; }
function reasonText(r = '') {
  return ({ wall: '撞墙', body: '撞到蛇身', headToHead: '头撞头', headOn: '头撞头', disconnectTimeout: '断线超时', disconnected: '断线' }[r] || r);
}
function fmtTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function teamColor(id) { return teamById(id)[2]; }

const ctx = els.field.getContext('2d');
function draw(snap = {}) {
  const w = els.field.width, h = els.field.height, cw = w / 40, ch = h / 28;
  ctx.clearRect(0, 0, w, h);
  for (let y = 0; y < 28; y++) {
    ctx.fillStyle = y % 2 ? '#11804a' : '#0d6b3b';
    ctx.fillRect(0, y * ch, w, ch);
  }
  drawPitch(w, h);
  (snap.foods || []).forEach(f => ball(f));
  (snap.snakes || []).forEach(s => snake(s));
}
function drawPitch(w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,.88)';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.beginPath(); ctx.moveTo(w / 2, 8); ctx.lineTo(w / 2, h - 8); ctx.stroke();
  ctx.beginPath(); ctx.arc(w / 2, h / 2, 90, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeRect(8, h * .28, 118, h * .44);
  ctx.strokeRect(w - 126, h * .28, 118, h * .44);
}
function point(p) { return { x: p?.x ?? p?.[0] ?? 0, y: p?.y ?? p?.[1] ?? 0 }; }
function ball(food) {
  const p = point(food.position || food), cw = els.field.width / 40, ch = els.field.height / 28;
  const isCorpse = food.type === 'corpse';
  const cx = (p.x + .5) * cw;
  const cy = (p.y + .5) * ch;
  const r = Math.min(cw, ch) * (isCorpse ? .38 : .32);
  if (isCorpse) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 80, 40, .95)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ff6b35';
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = isCorpse ? '#ffcf5a' : '#f8f8f8';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = isCorpse ? '#8b2f12' : '#111'; ctx.lineWidth = isCorpse ? 4 : 2; ctx.stroke();
  ctx.fillStyle = isCorpse ? '#8b2f12' : '#111'; ctx.beginPath(); ctx.arc(cx, cy, r * .34, 0, Math.PI * 2); ctx.fill();
  if (isCorpse) {
    ctx.fillStyle = '#fff7bf';
    ctx.font = '900 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('+5', cx, cy - r - 6);
  }
}
function snake(s) {
  const body = s.body || s.segments || [];
  const a = appearanceOf(s);
  const cw = els.field.width / 40, ch = els.field.height / 28;
  if (s.boostActive && body.length) drawBoostTrail(s, body, a, cw, ch);
  body.forEach((seg, i) => {
    const p = point(seg);
    const dir = i === 0 ? snakeDirection(s, body) : 'right';
    drawSnakeToken(ctx, p.x * cw + cw / 2, p.y * ch + ch / 2, Math.min(cw, ch) - 5, a, i, dir, Boolean(s.boostActive));
  });
}
function snakeDirection(s, body = []) {
  if (s.direction) return s.direction;
  const head = point(body[0]), neck = point(body[1]);
  const dx = head.x - neck.x, dy = head.y - neck.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}
function drawBoostTrail(s, body, a, cw, ch) {
  const dir = snakeDirection(s, body);
  const tail = point(body[body.length - 1]);
  const offset = { right: [-1, 0], left: [1, 0], down: [0, -1], up: [0, 1] }[dir] || [-1, 0];
  const cx = (tail.x + .5 + offset[0] * .55) * cw;
  const cy = (tail.y + .5 + offset[1] * .55) * ch;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate({ right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir] || 0);
  const flame = ctx.createLinearGradient(-cw * 1.4, 0, cw * .2, 0);
  flame.addColorStop(0, 'rgba(246,196,67,0)');
  flame.addColorStop(.48, 'rgba(246,196,67,.9)');
  flame.addColorStop(1, a.accent || '#fff7bf');
  ctx.fillStyle = flame;
  ctx.beginPath();
  ctx.moveTo(-cw * 1.5, 0);
  ctx.lineTo(-cw * .2, -ch * .33);
  ctx.lineTo(cw * .18, 0);
  ctx.lineTo(-cw * .2, ch * .33);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function drawSnakeToken(c, cx, cy, size, a, index = 0, direction = 'right', boosted = false) {
  const head = index === 0;
  const r = size / 2;
  c.save();
  c.translate(cx, cy);
  if (boosted) { c.shadowColor = 'rgba(246,196,67,.85)'; c.shadowBlur = head ? 22 : 12; }
  c.fillStyle = head ? a.secondaryColor : a.primaryColor;
  c.strokeStyle = head ? a.primaryColor : a.secondaryColor;
  c.lineWidth = head ? 5 : 3;
  roundRectCtx(c, -r, -r, size, size, Math.max(8, size * .28));
  c.fill();
  c.stroke();
  drawSkinPattern(c, a, size, head);
  if (head) drawSnakeFace(c, size, a, direction);
  c.restore();
}
function drawSkinPattern(c, a, size, head) {
  c.save();
  c.lineCap = 'round';
  if (a.skinId === 'lightning') {
    c.strokeStyle = a.accent; c.lineWidth = Math.max(3, size * .12);
    c.beginPath(); c.moveTo(-size * .28, -size * .22); c.lineTo(size * .02, -size * .04); c.lineTo(-size * .1, size * .23); c.lineTo(size * .3, size * .02); c.stroke();
  } else if (a.skinId === 'star') {
    c.fillStyle = a.secondaryColor;
    for (let i = 0; i < 3; i += 1) { c.beginPath(); c.arc((-0.23 + i * 0.22) * size, (i % 2 ? .12 : -.12) * size, Math.max(2, size * .06), 0, Math.PI * 2); c.fill(); }
  } else if (a.skinId === 'champion') {
    c.strokeStyle = '#ffd43b'; c.lineWidth = Math.max(3, size * .1); c.strokeRect(-size * .36, -size * .36, size * .72, size * .72);
  } else if (!head) {
    c.fillStyle = a.secondaryColor; c.globalAlpha = .42; c.fillRect(-size * .32, -size * .08, size * .64, size * .16);
  }
  if (!head) { c.fillStyle = 'rgba(255,255,255,.2)'; c.beginPath(); c.arc(-size * .18, -size * .18, size * .13, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function drawSnakeFace(c, size, a, direction) {
  const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[direction] || 0;
  c.rotate(angle);
  c.fillStyle = a.accent;
  c.beginPath(); c.arc(size * .18, 0, size * .24, -Math.PI / 2, Math.PI / 2); c.fill();
  c.fillStyle = '#10251c';
  c.beginPath(); c.arc(size * .18, -size * .16, size * .06, 0, Math.PI * 2); c.arc(size * .18, size * .16, size * .06, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(16,37,28,.78)'; c.lineWidth = Math.max(2, size * .04);
  c.beginPath(); c.moveTo(size * .34, -size * .08); c.lineTo(size * .43, 0); c.lineTo(size * .34, size * .08); c.stroke();
}
function roundRectCtx(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }
function roundRect(x, y, w, h, r) { roundRectCtx(ctx, x, y, w, h, r); }

function startMock() {
  show('lobbyPanel');
  state.roomId = 'MOCK01';
  renderRoom({ roomId: 'MOCK01', players: [{ playerId: '1', nickname: '巴西闪电', country: 'bra', ready: true, isHost: true, appearance: makeAppearance('bra', 'lightning') }, { playerId: '2', nickname: '法国铁卫', country: 'fra', ready: true, appearance: makeAppearance('fra', 'champion') }, { playerId: '3', nickname: '荷兰飞翼', country: 'ned', ready: false, appearance: makeAppearance('ned', 'star') }] });
  let seq = 0;
  setInterval(() => {
    seq += 1;
    const head = 4 + (seq % 24);
    renderSnapshot({
      snapshotSeq: seq,
      serverTick: seq,
      remainingMs: Math.max(0, 120000 - seq * 500),
      players: [
        { playerId: '1', nickname: '巴西闪电', country: 'bra', score: 30 + seq, alive: true, appearance: makeAppearance('bra', 'lightning') },
        { playerId: '2', nickname: '法国铁卫', country: 'fra', score: 20, aliveState: seq > 18 ? 'eliminated' : 'alive', deathReason: 'wall', appearance: makeAppearance('fra', 'champion') },
        { playerId: '3', nickname: '荷兰飞翼', country: 'ned', score: 10, alive: true, appearance: makeAppearance('ned', 'star') },
      ],
      snakes: [
        { playerId: '1', country: 'bra', direction: 'right', body: [{ x: head, y: 5 }, { x: head - 1, y: 5 }, { x: head - 2, y: 5 }] },
        { playerId: '2', country: 'fra', direction: 'left', body: [{ x: 22, y: 11 }, { x: 23, y: 11 }, { x: 24, y: 11 }] },
        { playerId: '3', country: 'ned', direction: 'up', body: [{ x: 8, y: 21 }, { x: 8, y: 22 }, { x: 8, y: 23 }] },
      ],
      foods: [{ position: { x: 10, y: 8 } }, { position: { x: 28, y: 20 }, type: 'corpse', value: 5 }, { position: { x: 32, y: 6 } }],
      events: seq === 2 ? [{ type: 'countdown', tick: seq }] : seq === 8 ? [{ type: 'eat', playerId: '1', position: { x: head, y: 5 }, tick: seq }] : seq === 14 ? [{ type: 'foodEaten', playerId: '1', position: { x: 28, y: 20 }, foodType: 'corpse', value: 5, ownerPlayerId: '2', tick: seq }] : seq === 20 ? [{ type: 'eliminated', playerId: '2', reason: 'wall', tick: seq }] : seq === 24 ? [{ type: 'leadChanged', playerId: '1', previousLeaderId: '2', tick: seq }] : [],
    });
  }, 500);
}
connect();
