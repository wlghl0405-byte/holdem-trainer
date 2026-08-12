/** 엔진 검증 (node test-engine.js) */
const H = require('./engine.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

// "As Kd 7h" 같은 문자열 → 카드 배열
const S = { s: 0, h: 1, d: 2, c: 3 };
const R = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
const P = (str) => str.trim().split(/\s+/).map((t) => ({ r: R[t[0]] || +t[0], s: S[t[1]] }));

/* 1. 족보 카테고리 판정 */
const cases = [
  ['As Ks Qs Js Ts 2h 3d', 9, '로열'],
  ['9s 8s 7s 6s 5s Ah Kd', 8, '스트레이트 플러시'],
  ['As 2s 3s 4s 5s Kh Qd', 8, '휠 스트레이트 플러시'],
  ['7h 7d 7c 7s 2h 3d 4c', 7, '포카드'],
  ['7h 7d 7c 4s 4h 2d 3c', 6, '풀하우스'],
  ['7h 7d 7c 4s 4h 2d 2c', 6, '풀하우스(투페어 동반)'],
  ['As Ks 9s 5s 2s 7h 8d', 5, '플러시'],
  ['9h 8d 7c 6s 5h Ad Kc', 4, '스트레이트'],
  ['Ah 2d 3c 4s 5h Kd Qc', 4, '휠 스트레이트'],
  ['7h 7d 7c 9s 5h 2d 3c', 3, '트리플'],
  ['7h 7d 9c 9s 5h 2d 3c', 2, '투페어'],
  ['7h 7d 9c 5s 3h 2d Kc', 1, '원페어'],
  ['Ah Kd 9c 7s 5h 3d 2c', 0, '하이카드'],
];
cases.forEach(([s, cat, name]) => ok(H.catOf(H.evaluate(P(s))) === cat, `${name}: ${s} → ${H.catOf(H.evaluate(P(s)))} (기대 ${cat})`));

/* 2. 플러시보다 풀하우스/포카드가 우선 */
ok(H.evaluate(P('7h 7d 7c 4h 4d 2h 3h')) > H.evaluate(P('Ah Kh 9h 5h 2h 7d 8c')) === false ||
   H.catOf(H.evaluate(P('7h 7d 7s 4h 4d 2h 3h'))) === 6, '풀하우스 판정(하트 4장이라 플러시 아님)');
{
  // 하트 5장 + 풀하우스가 동시에 가능한 7장
  const c = P('7h 7d 7s 4h 2h 9h Kh'); // 하트 5장(4h 2h 9h Kh 7h) + 트리플7
  ok(H.catOf(H.evaluate(c)) === 5, '플러시 vs 트리플 → 플러시 선택');
}
{
  const c = P('7h 7d 7s 7c 4h 2h 9h'); // 포카드 + 하트4장(플러시 아님)
  ok(H.catOf(H.evaluate(c)) === 7, '포카드 우선');
}

/* 3. 강약 비교 */
ok(H.evaluate(P('As Ah Kd Kc 2h 3d 4s')) > H.evaluate(P('Ks Kh Qd Qc 2h 3d 4s')), 'AA투페어 > KK투페어');
ok(H.evaluate(P('As Ah 9d 8c 2h 3d 4s')) < H.evaluate(P('2s 2h 2d 8c 9h 3d 4s')), '원페어 < 트리플');
ok(H.evaluate(P('9h 8d 7c 6s 5h 2d 3c')) > H.evaluate(P('8h 7d 6c 5s 4h 2d 3c')), '9하이 스트레이트 > 8하이');
ok(H.evaluate(P('Ah Kd Qc Js 9h 2d 3c')) > H.evaluate(P('Ah Kd Qc Js 8h 2d 3c')), '킥커 비교');
ok(H.evaluate(P('As Ks Qs Js 9s 2d 3c')) > H.evaluate(P('As Ks Qs Ts 9s 2d 3c')), '플러시 하이카드 비교');

/* 4. 무승부 */
ok(H.evaluate(P('As Ah 9d 8c 7h 2d 3c')) === H.evaluate(P('Ac Ad 9h 8s 7c 2h 3s')), '동일 족보 = 무승부');

/* 5. bestFive: 5장이 실제 최고 조합인지 */
{
  const b = H.bestFive(P('As Ks Qs Js Ts 2h 3d'));
  ok(b.cards.length === 5 && H.catOf(b.score) === 9, 'bestFive 로열 5장 추출');
  const b2 = H.bestFive(P('7h 7d 7c 4s 4h 2d 3c'));
  ok(H.catOf(b2.score) === 6 && b2.cards.filter((c) => c.r === 7).length === 3, 'bestFive 풀하우스 구성');
}

/* 6. 덱/남은카드 */
ok(H.newDeck().length === 52, '덱 52장');
ok(H.remainingDeck(P('As Ks')).length === 50, '남은 카드 50장');
{
  const ids = new Set(H.newDeck().map(H.cardId));
  ok(ids.size === 52, '카드 ID 중복 없음');
}

/* 7. 확률 계산 sanity */
{
  const eqAA = H.equity(P('As Ah'), [], 1, 4000);
  ok(eqAA > 0.80 && eqAA < 0.88, `AA vs 1명 승률 ${(eqAA * 100).toFixed(1)}% (기대 80~88%)`);
  const eq72 = H.equity(P('7h 2d'), [], 1, 4000);
  ok(eq72 > 0.30 && eq72 < 0.40, `72o vs 1명 승률 ${(eq72 * 100).toFixed(1)}% (기대 30~40%)`);
  const eqAA6 = H.equity(P('As Ah'), [], 5, 3000);
  ok(eqAA6 > 0.30 && eqAA6 < 0.55, `AA vs 5명 승률 ${(eqAA6 * 100).toFixed(1)}% (기대 30~55%)`);
}

/* 8. 아웃츠: 플러시 드로우 = 9장 */
{
  const o = H.outs(P('As Ks'), P('9s 4s 2h'));
  ok(o.n >= 9, `플러시 드로우 아웃츠 ${o.n}장 (스트레이트/페어 포함 9장 이상)`);
  const spades = o.cards.filter((c) => c.s === 0).length;
  ok(spades === 9, `스페이드 아웃츠 정확히 9장 (실제 ${spades})`);
}

/* 9. outlook 확률 합 = 1 */
{
  const o = H.outlook(P('As Ks'), P('9s 4s 2h'));
  const sum = o.dist.reduce((a, x) => a + x.p, 0);
  ok(Math.abs(sum - 1) < 1e-9, `outlook 확률 합 ${sum}`);
  ok(o.total === (47 * 46) / 2, `플랍 조합수 ${o.total} (기대 1081)`);
}

/* 10. 사이드팟 */
{
  const players = [
    { committed: 100, folded: false }, // 올인 100
    { committed: 500, folded: false },
    { committed: 500, folded: false },
    { committed: 50, folded: true },   // 폴드
  ];
  const pots = H.buildPots(players);
  const total = pots.reduce((a, p) => a + p.amt, 0);
  ok(total === 1150, `사이드팟 총액 ${total} (기대 1150)`);
  ok(pots[0].amt === 350 && pots[0].eligible.length === 3, `메인팟 ${pots[0].amt}/3명 (기대 350: 100+100+100+50)`);
  ok(pots[1].amt === 800 && pots[1].eligible.length === 2, `사이드팟 ${pots[1].amt}/2명 (기대 800)`);
}
{
  const players = [
    { committed: 200, folded: false },
    { committed: 200, folded: false },
  ];
  const pots = H.buildPots(players);
  ok(pots.length === 1 && pots[0].amt === 400, '단일 팟 400');
}

/* 11. 나를 이기는 조합 계산 */
{
  // 넛(로열)이면 이기는 조합이 0
  const b1 = H.beatingHands(P('As Ks'), P('Qs Js Ts'));
  ok(b1.beat === 0, `로열 완성 시 나를 이기는 조합 0 (실제 ${b1.beat})`);
  ok(b1.total === (47 * 46) / 2, `조합 총수 ${b1.total} (기대 1081)`);

  // 최악: 하이카드일 때는 다수에게 진다
  const b2 = H.beatingHands(P('7h 2d'), P('As Kd 9c'));
  ok(b2.beat / b2.total > 0.5, `약한 손은 절반 이상에게 짐 (${(b2.beat / b2.total * 100).toFixed(0)}%)`);

  // 보드에 셋이 깔린 경우 내 탑페어는 여러 조합에 진다
  const b3 = H.beatingHands(P('Ah Kd'), P('Ac 7h 2s'));
  ok(b3.beat > 0 && b3.beat < b3.total, `탑페어: 이기는 조합 일부 존재 (${b3.beat}/${b3.total})`);
  ok(H.catOf(b3.myScore) === 1, '탑페어 판정');
}

/* 12. 보드 위험 요소 */
{
  const t1 = H.boardTexture(P('As Ks Qs'));
  ok(t1.flush === 3 && t1.straight >= 3, '모노톤+브로드웨이 보드 감지');
  const t2 = H.boardTexture(P('7h 7d 2c'));
  ok(t2.paired === true, '페어드 보드 감지');
  const t3 = H.boardTexture(P('9h 8d 7c'));
  ok(t3.straight >= 3, '스트레이트 근접 보드 감지');
  const t4 = H.boardTexture(P('2h 7d Kc'));
  ok(!t4.paired && t4.flush === 1 && t4.straight < 3, '무난한 레인보우 보드');
}

/* 13. 프리플랍 핸드 분류 */
{
  ok(H.handClass(P('As Ah')).label === 'AA' && H.handClass(P('As Ah')).tier === 'S', 'AA = S티어');
  ok(H.handClass(P('Ks Kh')).tier === 'S', 'KK = S티어');
  ok(H.handClass(P('As Ks')).label === 'AKs' && H.handClass(P('As Ks')).tier === 'S', 'AKs = S티어');
  ok(H.handClass(P('Ah Kd')).label === 'AKo', 'AKo 라벨');
  ok(H.handClass(P('7h 2d')).tier === 'D', '72o = D티어(최약)');
  ok(H.handClass(P('9s 8s')).suited === true, '수티드 판정');
  ok(H.handClass(P('5h 5d')).pair === true, '포켓페어 판정');
}

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
