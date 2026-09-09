/**
 * 봇 난이도 검증 (node test-bots.js)
 * 봇끼리만 앉혀 여러 판을 돌리고, 강한 성향이 약한 성향보다 칩을 더 따는지 본다.
 * 사람 없이 table.js만으로 진행하므로 빠르다.
 */
const TB = require('./table.js');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

function match(styles, hands, seed) {
  const cfg = { stack: 10000, bb: 100, diff: 'normal' };
  const T = new TB.Table(cfg, () => {});
  styles.forEach((st, i) => T.addPlayer({ name: st + i, human: false, bot: true, style: st }));
  const base = cfg.stack * styles.length;
  let played = 0, guard = 0;
  T.startHand();
  while (played < hands) {
    if (++guard > hands * 2000) throw new Error('교착');
    const p = T.pending();
    if (p === 'bot' || p === 'stage') T.next();
    else if (p === 'showdown') {
      const sum = T.players.reduce((a, q) => a + q.stack, 0);
      if (sum !== base) { console.log('  ✗ 칩 총량 ' + sum + ' ≠ ' + base); fail++; return null; }
      played++;
      T.players.forEach((q) => { if (q.stack <= 0) { q.stack = cfg.stack; q.out = false; T.rebuy = (T.rebuy || 0) + cfg.stack; } });   // 파산자 리바이(순손익 집계용)
      if (T.rebuy) { /* 총량 기준선 갱신 */ }
      T.startHand();
    } else if (p === 'over' || p === 'idle') break;
    else throw new Error('사람 차례가 나오면 안 됨: ' + p);
  }
  return T.players.map((q) => ({ style: q.style, net: q.stack - cfg.stack - (q.rebuys || 0) }));
}

// 리바이를 성향별로 집계하기 위해 간단히 다시: 스택 합만 비교 (리바이 시 손실 반영)
function tourney(styles, hands) {
  const cfg = { stack: 10000, bb: 100, diff: 'normal' };
  const T = new TB.Table(cfg, () => {});
  styles.forEach((st, i) => T.addPlayer({ name: st + i, human: false, bot: true, style: st }));
  const loss = {}; styles.forEach((s) => { loss[s] = 0; });
  let played = 0, guard = 0;
  T.startHand();
  while (played < hands) {
    if (++guard > hands * 2000) throw new Error('교착');
    const p = T.pending();
    if (p === 'bot' || p === 'stage') T.next();
    else if (p === 'showdown') {
      played++;
      T.players.forEach((q) => { if (q.stack <= 0) { loss[q.style] += cfg.stack; q.stack = cfg.stack; q.out = false; } });
      T.startHand();
    } else break;
  }
  const net = {};
  styles.forEach((s) => { net[s] = 0; });
  T.players.forEach((q) => { net[q.style] += q.stack - cfg.stack; });
  Object.keys(net).forEach((s) => { net[s] -= loss[s]; });
  return net;
}

console.log('봇 성향 검증 (각 300핸드)');
const t0 = Date.now();
const r1 = tourney(['pro', 'pro', 'easy', 'easy'], 300);
console.log('  · 프로 vs 초급:', JSON.stringify(r1));
ok(r1.pro > r1.easy, '프로 2명이 초급 2명보다 많이 땀');
const r2 = tourney(['pro', 'pro', 'normal', 'normal'], 300);
console.log('  · 프로 vs 중급:', JSON.stringify(r2));
ok(r2.pro > r2.normal, '프로가 중급보다 많이 땀');
const r3 = tourney(['hard', 'hard', 'easy', 'easy'], 300);
console.log('  · 고수 vs 초급:', JSON.stringify(r3));
ok(r3.hard > r3.easy, '고수가 초급보다 많이 땀');
const r4 = tourney(['pro', 'maniac', 'rock', 'normal', 'hard', 'easy'], 300);
console.log('  · 6인 섞기:', JSON.stringify(r4));
ok(Object.values(r4).every((v) => Number.isFinite(v)), '섞기 테이블 정상 진행');
console.log('  · 소요 ' + ((Date.now() - t0) / 1000).toFixed(1) + '초');
console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
