/**
 * server.js — 홀덤 트레이너 온라인 서버 (Node + ws)
 *
 *   node server.js            → http://localhost:8080
 *   PORT 환경변수로 포트 지정 (Render 등 호스팅은 자동으로 넣어 준다)
 *
 * 역할
 *   - index.html / engine.js / table.js 정적 제공 (같은 주소에서 게임 화면과 WebSocket을 함께 처리)
 *   - 방(room) 관리: 방장이 만들고 4자리 코드 또는 링크(?room=CODE)로 입장
 *   - 덱·진행은 table.js가 서버 안에서 쥔다. 각 접속자에게는 자기 좌석 기준 화면 상태만 보낸다.
 *   - 새로고침·끊김 대비: 입장 시 받은 토큰으로 다시 붙으면 같은 자리로 복귀
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const TB = require('./table.js');

const PORT = process.env.PORT || 8080;
const SPEEDS = {
  slow: { ai: 1500, stage: 1400 }, normal: { ai: 800, stage: 800 }, fast: { ai: 360, stage: 420 },
};
const OFFLINE_GRACE_MS = 6000;  // 접속이 끊긴 사람 차례는 이만큼 기다렸다가 자동 처리
const NEXT_HAND_SEC = 3;        // 쇼다운 후 다음 핸드까지
const ROOM_IDLE_MS = 3 * 3600 * 1000; // 아무 일도 없는 방은 3시간 뒤 정리

/* ───────── 정적 파일 ───────── */
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/engine.js': 'engine.js', '/table.js': 'table.js', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js', '/icon.svg': 'icon.svg' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok ' + rooms.size + ' rooms'); }
  const file = STATIC[url.pathname];
  if (!file || !fs.existsSync(path.join(__dirname, file))) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
});

/* ───────── 방 ───────── */
const rooms = new Map();
const CODE_CHARS = '0123456789'; // 숫자 4자리
function newCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; } while (rooms.has(c));
  return c;
}
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

class Room {
  constructor(code) {
    this.code = code;
    this.seats = [];              // {name, token, ws, bot, online, leave}
    this.waiting = [];            // 진행 중 들어온 사람 (다음 핸드부터 참여)
    this.cfg = { stack: 10000, bb: 100, diff: 'normal', speed: 'slow', turn: 30 };
    this.table = new TB.Table(this.cfg, (type, data) => this.onEvent(type, data));
    this.playing = false;
    this.timer = null; this.clock = null;
    this.dirty = false;
    this.touch();
  }
  touch() { this.lastActive = Date.now(); }
  humans() { return this.seats.filter((s) => !s.bot); }
  hostSeat() { return this.seats.find((s) => !s.bot && !s.leave) || null; }
  isHost(seat) { return this.hostSeat() === seat; }

  /* ── 로비 ── */
  lobbyMsg(forSeat) {
    return {
      t: 'lobby', playing: this.playing, cfg: this.cfg, host: this.isHost(forSeat),
      players: this.seats.map((s) => ({ name: s.name, bot: !!s.bot, host: this.isHost(s), online: s.bot ? true : !!s.online })),
    };
  }
  broadcastLobby() { this.seats.forEach((s) => { if (!s.bot) send(s.ws, this.lobbyMsg(s)); }); }

  addHuman(name, ws, token) {
    const seat = { name, token: token || crypto.randomBytes(12).toString('hex'), ws, bot: false, online: true, leave: false };
    if (this.playing) { this.waiting.push(seat); }
    this.seats.push(seat);
    return seat;
  }
  addBot() {
    const [name] = TB.pickNames(1, this.seats.map((s) => s.name));
    const seat = { name, token: '', ws: null, bot: true, online: true, leave: false };
    if (this.playing) this.waiting.push(seat);
    this.seats.push(seat);
    return seat;
  }
  removeSeat(seat) {
    const i = this.seats.indexOf(seat);
    if (i < 0) return;
    if (this.playing && !this.waiting.includes(seat)) { seat.leave = true; seat.online = false; return; } // 핸드 끝나고 정리
    this.seats.splice(i, 1);
    const w = this.waiting.indexOf(seat); if (w >= 0) this.waiting.splice(w, 1);
  }

  /* ── 게임 시작 ── */
  start(cfg) {
    if (this.playing) return false;
    const live = this.seats.filter((s) => !s.leave);
    if (live.length < 2) return false;
    Object.assign(this.cfg, {
      stack: Math.max(100, Math.min(10000000, Math.round(+cfg.stack) || 10000)),
      bb: 100, diff: ['easy', 'normal', 'hard', 'pro', 'mix'].includes(cfg.diff) ? cfg.diff : 'normal',
      speed: SPEEDS[cfg.speed] ? cfg.speed : 'slow',
      turn: [0, 5, 10, 15, 30, 60, 90, 120].includes(+cfg.turn) ? +cfg.turn : 30,
    });
    this.cfg.bb = Math.max(2, Math.min(Math.floor(this.cfg.stack / 2), Math.round(+cfg.bb) || 100));
    this.seats = live; this.waiting = [];
    this.table.reset();
    this.seats.forEach((s, i) => { const p = this.table.addPlayer({ id: i, name: s.name, human: !s.bot, bot: s.bot, stack: this.cfg.stack, style: s.bot ? TB.Table.styleFor(this.cfg.diff) : undefined }); p.online = s.online; s.player = p; });
    this.playing = true;
    this.broadcastLobby();
    this.drive();                 // 테이블만 깔림(stage idle). 방장이 '시작'을 누르면 deal
    return true;
  }

  /** 핸드 사이: 나간 사람 정리, 기다리던 사람 착석 */
  betweenHands() {
    const T = this.table;
    // 나간 사람 제거 (칩은 사라진다)
    for (let i = this.seats.length - 1; i >= 0; i--) {
      const s = this.seats[i];
      if (s.leave) { const pi = T.players.indexOf(s.player); if (pi >= 0) T.players.splice(pi, 1); this.seats.splice(i, 1); }
    }
    // 대기자 착석
    this.waiting.forEach((s) => { const p = T.addPlayer({ name: s.name, human: !s.bot, bot: s.bot, stack: this.cfg.stack, style: s.bot ? TB.Table.styleFor(this.cfg.diff) : undefined }); p.online = s.online; s.player = p; });
    this.waiting = [];
    T.players.forEach((p, i) => { p.id = i; });
    // 파산자는 제외 상태로 남고(관전), 방장이 다시 시작하면 복구된다
  }

  onEvent(type, data) {
    if (type === 'state') { this.dirty = true; if (this.table.stage !== 'showdown') this.preBoard = this.table.board.length; return; }
    if (type === 'action' || type === 'stage' || type === 'hand') this.broadcast({ t: 'event', name: type, data });
  }
  broadcast(m) { this.seats.forEach((s) => { if (!s.bot && s.player) send(s.ws, m); }); }
  broadcastState() {
    this.dirty = false;
    this.seats.forEach((s) => {
      if (s.bot || !s.player) return;
      const seat = this.table.players.indexOf(s.player);
      if (seat >= 0) send(s.ws, { t: 'state', view: this.table.view(seat) });
    });
  }

  /** 상태 변경 후: 화면 전송 + 다음 진행 예약 */
  drive() {
    clearTimeout(this.timer); clearInterval(this.clock); this.timer = null; this.clock = null;
    this.touch();
    const T = this.table;
    this.broadcastState();
    const p = T.pending();
    const sp = SPEEDS[this.cfg.speed] || SPEEDS.slow;
    if (p === 'bot') this.timer = setTimeout(() => { T.next(); this.drive(); }, sp.ai);
    else if (p === 'stage') this.timer = setTimeout(() => { T.next(); this.drive(); }, sp.stage);
    else if (p === 'human') this.armTurnClock();
    else if (p === 'showdown') this.armNextHand();
    else if (p === 'over') this.gameOver();
  }

  armTurnClock() {
    const T = this.table;
    const seatIdx = T.toAct; const p = T.players[seatIdx];
    const s = this.seats.find((x) => x.player === p);
    const auto = () => { if (T.toAct !== seatIdx) return; const toCall = T.maxBet - p.bet; T.doAction(seatIdx, toCall > 0 ? 'fold' : 'check'); this.drive(); };
    if (!s || s.leave || !s.online) { this.timer = setTimeout(auto, OFFLINE_GRACE_MS); return; }
    const limit = this.cfg.turn;
    if (!limit) return;                                   // 무제한
    let left = limit;
    send(s.ws, { t: 'turnclock', sec: left });
    this.clock = setInterval(() => {
      left--;
      if (left > 0) send(s.ws, { t: 'turnclock', sec: left });
      if (left <= 0) { clearInterval(this.clock); auto(); }
    }, 1000);
  }

  armNextHand() {
    // 쇼다운 연출(보드 한 장씩·패 순서대로 공개)이 끝난 뒤 카운트다운을 시작한다
    const res = this.table.result;
    const rows = res && res.rows ? res.rows.length : 0;
    const k = { slow: 1, normal: 0.7, fast: 0.45 }[this.cfg.speed] || 1;
    const revealMs = rows >= 2 ? (900 * Math.max(0, 5 - (this.preBoard == null ? 5 : this.preBoard)) + 700 * rows + 1300) * k : 0;
    let left = NEXT_HAND_SEC;
    this.timer = setTimeout(() => {
    this.broadcast({ t: 'countdown', sec: left });
    this.clock = setInterval(() => {
      left--;
      this.broadcast({ t: 'countdown', sec: left });
      if (left <= 0) {
        clearInterval(this.clock); this.clock = null;
        this.betweenHands();
        this.broadcastLobby();
        this.table.startHand();
        this.drive();
      }
    }, 1000);
    }, revealMs);
  }

  gameOver() {
    const T = this.table;
    const alive = T.players.filter((p) => !p.out);
    const winner = alive.length === 1 ? alive[0].name : '';
    this.playing = false;
    this.seats.forEach((s) => { s.player = null; });
    this.seats = this.seats.filter((s) => !s.leave);
    this.waiting = [];
    this.seats.forEach((s) => { if (!s.bot) send(s.ws, { t: 'gameover', winner, lobby: this.lobbyMsg(s) }); });
  }

  /* ── 접속자 처리 ── */
  seatOf(ws) { return this.seats.find((s) => s.ws === ws) || null; }
  handle(seat, m) {
    this.touch();
    const T = this.table;
    if (m.t === 'act') {
      if (!this.playing || !seat.player) return;
      const idx = T.players.indexOf(seat.player);
      if (idx < 0 || idx !== T.toAct) return send(seat.ws, { t: 'error', msg: '지금은 내 차례가 아닙니다.' });
      if (T.doAction(idx, m.type, m.amount)) this.drive();
    } else if (m.t === 'start') {
      if (!this.isHost(seat)) return send(seat.ws, { t: 'error', msg: '방장만 시작할 수 있습니다.' });
      if (!this.start(m.cfg || {})) send(seat.ws, { t: 'error', msg: '2명 이상 있어야 시작합니다.' });
    } else if (m.t === 'deal') {
      if (!this.isHost(seat)) return send(seat.ws, { t: 'error', msg: '방장만 시작할 수 있습니다.' });
      if (!this.playing || (T.stage !== 'idle' && T.stage !== 'over')) return;
      T.startHand(); this.drive();
    } else if (m.t === 'addBot') {
      if (!this.isHost(seat)) return;
      if (this.seats.length >= 8) return send(seat.ws, { t: 'error', msg: '최대 8명입니다.' });
      this.addBot(); this.broadcastLobby();
    } else if (m.t === 'kick') {
      if (!this.isHost(seat)) return;
      const target = this.seats[m.seat];
      if (!target || target === seat) return;
      if (!target.bot) send(target.ws, { t: 'error', msg: '방장이 내보냈습니다.' });
      this.removeSeat(target);
      if (!target.bot && target.ws) { try { target.ws.close(); } catch (e) {} }
      this.broadcastLobby();
    } else if (m.t === 'chat') {
      const text = String(m.text || '').trim().slice(0, 80);
      const now = Date.now();
      if (!text || (seat.lastChat && now - seat.lastChat < 700)) return;
      seat.lastChat = now;
      this.seats.forEach((s) => { if (!s.bot) send(s.ws, { t: 'chat', name: seat.name, text }); });
    } else if (m.t === 'leave') {
      this.removeSeat(seat);
      if (seat.ws) seat.ws.room = null;
      this.broadcastLobby();
      this.cleanupIfEmpty();
    }
  }
  disconnect(seat) {
    seat.online = false; seat.ws = null;
    if (seat.player) seat.player.online = false;
    if (!this.playing) { this.removeSeat(seat); }
    this.broadcastLobby();
    if (this.playing) { this.dirty = true; this.broadcastState(); if (this.table.toAct >= 0 && this.table.players[this.table.toAct] === seat.player) { clearInterval(this.clock); this.armTurnClock(); } }
    this.cleanupIfEmpty();
  }
  cleanupIfEmpty() {
    if (this.humans().every((s) => !s.online)) {
      // 사람이 아무도 없으면 잠시 뒤 방 삭제 (새로고침 복귀 여지 60초)
      setTimeout(() => { if (rooms.get(this.code) === this && this.humans().every((s) => !s.online)) { clearTimeout(this.timer); clearInterval(this.clock); rooms.delete(this.code); } }, 60000);
    }
  }
}

/* ───────── WebSocket ───────── */
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const name = String(m.name || '').trim().slice(0, 12);
    if (m.t === 'create') {
      if (!name) return send(ws, { t: 'error', msg: '이름을 입력하세요.' });
      const room = new Room(newCode()); rooms.set(room.code, room);
      const seat = room.addHuman(name, ws); ws.room = room;
      send(ws, { t: 'joined', code: room.code, seat: 0, token: seat.token, host: true });
      room.broadcastLobby();
    } else if (m.t === 'join') {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: '방을 찾을 수 없습니다. 코드를 확인하세요.' });
      let seat = m.token ? room.seats.find((s) => !s.bot && s.token === m.token) : null;
      if (seat) {  // 복귀
        if (seat.ws && seat.ws !== ws) { try { seat.ws.close(); } catch (e) {} }
        seat.ws = ws; seat.online = true; seat.leave = false; if (name) seat.name = name;
        if (seat.player) { seat.player.online = true; seat.player.name = seat.name; }
      } else {
        if (!name) return send(ws, { t: 'error', msg: '이름을 입력하세요.' });
        if (room.seats.length >= 8) return send(ws, { t: 'error', msg: '방이 가득 찼습니다(최대 8명).' });
        if (room.seats.some((s) => s.name === name)) return send(ws, { t: 'error', msg: '같은 이름이 이미 있습니다. 다른 이름을 쓰세요.' });
        seat = room.addHuman(name, ws);
      }
      ws.room = room;
      send(ws, { t: 'joined', code: room.code, seat: room.seats.indexOf(seat), token: seat.token, host: room.isHost(seat) });
      room.broadcastLobby();
      if (room.playing && seat.player) { room.dirty = true; room.broadcastState(); }
    } else if (ws.room) {
      const seat = ws.room.seatOf(ws);
      if (seat) ws.room.handle(seat, m);
    }
  });
  ws.on('close', () => {
    const room = ws.room; if (!room) return;
    const seat = room.seatOf(ws); ws.room = null;
    if (seat) room.disconnect(seat);
  });
});
// 죽은 연결 정리 + 오래 논 방 삭제
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  rooms.forEach((room, code) => { if (now - room.lastActive > ROOM_IDLE_MS) { clearTimeout(room.timer); clearInterval(room.clock); rooms.delete(code); } });
}, 30000);

server.listen(PORT, () => { console.log('홀덤 트레이너 서버: http://localhost:' + PORT); });
module.exports = { server, rooms };
