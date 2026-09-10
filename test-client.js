/**
 * 온라인 클라이언트 검증 (node test-client.js)
 * index.html의 화면 스크립트를 가짜 DOM에서 실행하고, 서버가 실제로 만드는 좌석별 view를 그대로 넣어
 * 여러 핸드 동안 'state'·채팅·카운트다운·이벤트 처리에 오류가 없는지 본다.
 */
const fs = require('fs'), vm = require('vm');
const P = __dirname + '/';
const HE = require(P + 'engine.js'), TB = require(P + 'table.js');
function mkEl() { const el = { _cls: '', style: { setProperty() {} }, children: [], textContent: '', value: '', disabled: false, hidden: false, dataset: {}, offsetWidth: 0, getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  get className() { return this._cls; }, set className(v) { this._cls = v; },
  set innerHTML(v) { this._html = v; this.children = []; }, get innerHTML() { return this._html || ''; },
  appendChild(c) { this.children.push(c); return c; }, remove() {}, querySelector: () => mkEl(), querySelectorAll: () => [],
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, scrollTop: 0, scrollHeight: 0, click() {} }; return el; }
const els = {}; const document = { getElementById: (id) => els[id] || (els[id] = mkEl()), createElement: () => mkEl(), querySelectorAll: () => [], addEventListener() {}, title: '' };
const html = fs.readFileSync(P + 'index.html', 'utf8');
const src = html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/)[1] + '\n;globalThis.__api = { netHandle, G: () => G, MODE, NET, CHAT };';
const ctx = { HE, TB, document, window: { innerWidth: 1440, addEventListener() {} }, setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, Math, console, Set, Map, Array, Object, JSON, Number, String, isNaN, navigator: {}, URLSearchParams, location: { protocol: 'http:', origin: 'http://x', pathname: '/', search: '' }, globalThis: null };
ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src, ctx, { filename: 'game.js' });
const API = ctx.__api;
// 서버처럼 테이블을 만들고 각 좌석 view를 클라이언트에 넣는다
const T = new TB.Table({ stack: 10000, bb: 100, diff: 'mix', speed: 'fast' }, () => {});
T.addPlayer({ name: '나', human: true }); T.addBots(3); T.players[2].away = 'bot'; T.startHand();
let n = 0, err = 0;
const feed = (seat) => { try { API.netHandle({ t: 'joined', code: '1234', seat, token: 'x', host: seat === 0 }); API.netHandle({ t: 'state', view: T.view(seat) }); n++; } catch (e) { err++; if (err < 4) console.log('오류 seat', seat, T.stage, e.message, String(e.stack).split(String.fromCharCode(10)).slice(1,3).join(' / ')); } };
for (let step = 0; step < 300 && T.stage !== 'over'; step++) {
  for (let s = 0; s < T.players.length; s++) feed(s);
  const p = T.pending();
  if (p === 'human') { const me = T.players[T.toAct]; const toCall = T.maxBet - me.bet; T.doAction(T.toAct, toCall > 0 ? 'call' : 'check'); }
  else if (p === 'bot' || p === 'stage') T.next();
  else if (p === 'showdown') { T.players.forEach((q) => { if (q.stack <= 0) { q.stack = 10000; q.out = false; } }); T.startHand(); }
}
API.netHandle({ t: 'chat', name: '봇', text: '👍' }); API.netHandle({ t: 'countdown', sec: 3 }); API.netHandle({ t: 'turnclock', sec: 5 }); API.netHandle({ t: 'event', name: 'stage', data: { stage: 'flop', cards: T.board.slice(0, 3) } });
console.log('state 처리', n, '회, 오류', err, '회, 채팅 줄', API.CHAT.lines.length, ', MODE.net', API.MODE.net);
process.exit(err ? 1 : 0);
