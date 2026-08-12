/**
 * 게임 흐름 자동 검증 (node test-game.js)
 * index.html의 게임 스크립트를 가짜 DOM 위에서 실행해 수백 핸드를 돌린다.
 * 핵심 검증: 칩 총량 보존, 음수 스택 없음, 무한 루프 없음, 사이드팟 정산.
 */
const fs = require('fs');
const vm = require('vm');
const HE = require('./engine.js');

/* ── 최소 DOM 스텁 ── */
function mkEl() {
  const el = {
    _cls: '', style: {}, children: [], textContent: '', value: 0, disabled: false,
    get className() { return this._cls; }, set className(v) { this._cls = v; },
    set innerHTML(v) { this._html = v; this.children = []; }, get innerHTML() { return this._html || ''; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll: () => [],
    scrollTop: 0, scrollHeight: 0,
  };
  return el;
}
const els = {};
const document = {
  getElementById: (id) => els[id] || (els[id] = mkEl()),
  createElement: () => mkEl(),
  querySelectorAll: () => [],
};

/* ── 타이머: 큐에 모았다가 수동으로 흘린다 ── */
const timers = [];
const setTimeout_ = (fn) => { timers.push(fn); return timers.length; };
function drain(limit = 100000) {
  let n = 0;
  while (timers.length) {
    if (++n > limit) throw new Error('타이머 무한 루프 의심');
    timers.shift()();
  }
  return n;
}

/* ── 스크립트 로드 ── */
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/);
if (!m) { console.log('스크립트 추출 실패'); process.exit(1); }
const src = m[1] + '\n;globalThis.__api = { G, CFG, newGame, startHand, doAction, potTotal, inHand, canAct, endHand };';

const window = { innerWidth: 1440, addEventListener() {} };
const ctx = { HE, document, window, setTimeout: setTimeout_, clearTimeout: () => {}, Math, console, Set, Map, Array, Object, JSON, Number, String, isNaN, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'game.js' });
const API = ctx.__api;

/* ── 검증 실행 ── */
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

function playHands(opts) {
  const { opp, diff, hands, stack, bb } = opts;
  API.CFG.opp = opp; API.CFG.diff = diff; API.CFG.advisor = false;
  if (stack) API.CFG.stack = stack;
  if (bb) API.CFG.bb = bb;
  API.newGame();
  drain();
  const G = API.G;
  const BASE = API.CFG.stack * (opp + 1);
  let played = 0, guard = 0, allInSeen = 0, sidePotSeen = 0, rebuy = 0;

  while (played < hands) {
    if (++guard > hands * 400) { console.log('  ✗ 진행 불가(교착)'); fail++; break; }

    // 사람 차례면 무작위 액션
    if (G.toAct === 0 && G.stage !== 'showdown') {
      const me = G.players[0];
      const toCall = G.maxBet - me.bet;
      const r = Math.random();
      if (toCall > 0 && r < 0.18) API.doAction(0, 'fold');
      else if (toCall === 0 && r < 0.55) API.doAction(0, 'check');
      else if (r < 0.85 || toCall === 0) API.doAction(0, toCall > 0 ? 'call' : 'check');
      else {
        const target = Math.min(me.bet + me.stack, G.maxBet + Math.max(G.minRaise, API.CFG.bb * 2));
        if (target > G.maxBet) { API.doAction(0, 'raise', target); allInSeen += (target === me.bet + me.stack ? 1 : 0); }
        else API.doAction(0, toCall > 0 ? 'call' : 'check');
      }
      drain();
      continue;
    }

    if (G.stage === 'showdown') {
      // 정산 검증
      const sum = G.players.reduce((a, p) => a + p.stack, 0);
      if (sum !== BASE + rebuy) { console.log(`  ✗ 칩 총량 불일치: ${sum} (기대 ${BASE + rebuy}) · 핸드 ${G.handNo}`); fail++; return; }
      if (G.players.some((p) => p.stack < 0)) { console.log('  ✗ 음수 스택'); fail++; return; }
      const committedLevels = new Set(G.players.filter((p) => p.committed > 0).map((p) => p.committed));
      if (committedLevels.size > 1 && G.players.some((p) => p.allIn)) sidePotSeen++;
      played++;
      // 판수를 채워 더 깊게 검증하려고 파산자는 리바이 (총량 기준선도 함께 올림)
      G.players.forEach((p) => {
        if (p.stack <= 0) { p.stack = API.CFG.stack; p.out = false; rebuy += API.CFG.stack; }
      });
      API.startHand(); drain();
      continue;
    }

    // AI 차례인데 타이머가 비었으면 진행 유도
    if (timers.length === 0 && G.toAct >= 0 && !G.players[G.toAct].human) {
      console.log('  ✗ AI 차례인데 스케줄 없음 (교착) stage=' + G.stage); fail++; return;
    }
    drain();
  }
  // 루프 종료 시점엔 다음 핸드가 이미 시작돼 블라인드·베팅이 나가 있을 수 있으므로 committed를 합산해 비교
  const total = G.players.reduce((a, p) => a + p.stack + p.committed, 0);
  return { played, sidePotSeen, allInSeen, rebuy, total, TOTAL: BASE + rebuy };
}

console.log('게임 흐름 검증');
for (const cfg of [
  { opp: 1, diff: 'normal', hands: 60 },
  { opp: 3, diff: 'easy', hands: 60 },
  { opp: 5, diff: 'normal', hands: 60 },
  { opp: 8, diff: 'hard', hands: 40 },
]) {
  const r = playHands(cfg);
  if (r) {
    ok(r.played >= Math.min(cfg.hands, 5), `상대 ${cfg.opp}명/${cfg.diff}: ${r.played}핸드 진행`);
    ok(r.total === r.TOTAL, `상대 ${cfg.opp}명: 칩 총량 보존 ${r.total}/${r.TOTAL}`);
    console.log(`  · 상대 ${cfg.opp}명(${cfg.diff}) ${r.played}핸드 · 사이드팟 상황 ${r.sidePotSeen}회`);
  }
}

/* 최소 베팅(빅블라인드) 변경 검증: 홀수 BB·짧은 스택·큰 BB */
console.log('최소 베팅 설정 검증');
for (const cfg of [
  { opp: 3, diff: 'normal', hands: 30, stack: 10000, bb: 33 },    // 홀수 → SB 16
  { opp: 2, diff: 'normal', hands: 30, stack: 1000, bb: 100 },     // 짧은 스택(10BB)
  { opp: 4, diff: 'hard', hands: 25, stack: 100000, bb: 1000 },    // 큰 판
  { opp: 1, diff: 'easy', hands: 25, stack: 500, bb: 250 },        // 극단: 2BB 스택
]) {
  const r = playHands(cfg);
  if (r) {
    ok(r.total === r.TOTAL, `BB ${cfg.bb}/스택 ${cfg.stack}: 칩 총량 보존 ${r.total}/${r.TOTAL}`);
    ok(Number.isInteger(r.total), `BB ${cfg.bb}: 칩이 정수 유지`);
    console.log(`  · BB ${cfg.bb} 스택 ${cfg.stack} → ${r.played}핸드`);
  }
}
API.CFG.stack = 10000; API.CFG.bb = 100;

/* 블라인드/버튼 로테이션 확인 */
{
  API.CFG.opp = 3; API.CFG.diff = 'normal'; API.CFG.advisor = false;
  API.newGame(); drain();
  const btns = [];
  for (let i = 0; i < 6; i++) {
    btns.push(API.G.btn);
    // 강제 종료 후 다음 핸드
    API.G.players.forEach((p, idx) => { if (idx !== 0) p.folded = true; });
    API.endHand(); drain();
    API.startHand(); drain();
  }
  const uniq = new Set(btns);
  ok(uniq.size > 1, `버튼 로테이션 (${btns.join('→')})`);
}

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
