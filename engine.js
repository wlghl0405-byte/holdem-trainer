/**
 * 텍사스 홀덤 엔진 (평가기 · 확률 계산)
 * 브라우저와 node 양쪽에서 쓰도록 UMD 스타일로 노출한다. (node = 테스트용)
 */
(function (root) {
  'use strict';

  // 카드: {r: 2~14, s: 0~3}  s: 0=♠ 1=♥ 2=♦ 3=♣
  const RANK_STR = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const SUIT_CH = ['♠', '♥', '♦', '♣'];

  const rankName = (r) => RANK_STR[r] || String(r);
  const cardName = (c) => rankName(c.r) + SUIT_CH[c.s];
  const cardId = (c) => c.r * 4 + c.s;

  function newDeck() {
    const d = [];
    for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
    return d;
  }

  function shuffle(d, rnd) {
    const rand = rnd || Math.random;
    for (let i = d.length - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  // 족보 (숫자가 클수록 강함)
  const CATS = [
    { k: 0, ko: '하이카드', en: 'High Card' },
    { k: 1, ko: '원페어', en: 'One Pair' },
    { k: 2, ko: '투페어', en: 'Two Pair' },
    { k: 3, ko: '트리플', en: 'Three of a Kind' },
    { k: 4, ko: '스트레이트', en: 'Straight' },
    { k: 5, ko: '플러시', en: 'Flush' },
    { k: 6, ko: '풀하우스', en: 'Full House' },
    { k: 7, ko: '포카드', en: 'Four of a Kind' },
    { k: 8, ko: '스트레이트 플러시', en: 'Straight Flush' },
    { k: 9, ko: '로열 스트레이트 플러시', en: 'Royal Flush' },
  ];

  // 점수 = cat * 15^5 + tb1*15^4 + ... (사전식 비교를 정수 하나로)
  const P5 = 759375, P4 = 50625, P3 = 3375, P2 = 225, P1 = 15;
  function score(cat, t1, t2, t3, t4, t5) {
    return cat * P5 + (t1 || 0) * P4 + (t2 || 0) * P3 + (t3 || 0) * P2 + (t4 || 0) * P1 + (t5 || 0);
  }
  const catOf = (sc) => Math.floor(sc / P5);

  // 유니크 랭크 내림차순 배열에서 스트레이트 최고값 (없으면 0). A-5 휠 포함.
  function straightHigh(uniqDesc) {
    const u = uniqDesc.slice();
    if (u[0] === 14) u.push(1); // 휠(A2345)
    let run = 1;
    for (let i = 1; i < u.length; i++) {
      if (u[i] === u[i - 1] - 1) {
        run++;
        if (run >= 5) return u[i] + 4;
      } else if (u[i] !== u[i - 1]) {
        run = 1;
      }
    }
    return 0;
  }

  /**
   * 5~7장에서 최고 5장의 점수. 순위: SF > 포카드 > 풀하우스 > 플러시 > 스트레이트 > ...
   * (플러시가 있어도 포카드·풀하우스가 우선이므로 검사 순서가 중요)
   */
  function evaluate(cards) {
    const cnt = new Array(15).fill(0);
    const suitCnt = [0, 0, 0, 0];
    for (let i = 0; i < cards.length; i++) {
      cnt[cards[i].r]++;
      suitCnt[cards[i].s]++;
    }
    const uniq = [];
    for (let r = 14; r >= 2; r--) if (cnt[r]) uniq.push(r);

    // 플러시 수트
    let fs = -1;
    for (let s = 0; s < 4; s++) if (suitCnt[s] >= 5) { fs = s; break; }

    // 스트레이트 플러시
    if (fs >= 0) {
      const fr = [];
      const seen = new Array(15).fill(false);
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].s === fs && !seen[cards[i].r]) { seen[cards[i].r] = true; fr.push(cards[i].r); }
      }
      fr.sort((a, b) => b - a);
      const sh = straightHigh(fr);
      if (sh) return score(sh === 14 ? 9 : 8, sh);
    }

    // 포카드 / 풀하우스 / 트리플 / 페어 집계
    let quad = 0, trip = 0, trip2 = 0, pair = 0, pair2 = 0;
    for (let r = 14; r >= 2; r--) {
      if (cnt[r] === 4 && !quad) quad = r;
      else if (cnt[r] === 3) { if (!trip) trip = r; else if (!trip2) trip2 = r; }
      else if (cnt[r] === 2) { if (!pair) pair = r; else if (!pair2) pair2 = r; }
    }

    if (quad) {
      let kick = 0;
      for (let i = 0; i < uniq.length; i++) if (uniq[i] !== quad) { kick = uniq[i]; break; }
      return score(7, quad, kick);
    }
    if (trip && (pair || trip2)) {
      const low = trip2 > pair ? trip2 : pair;
      return score(6, trip, low);
    }
    if (fs >= 0) {
      const fr = [];
      for (let i = 0; i < cards.length; i++) if (cards[i].s === fs) fr.push(cards[i].r);
      fr.sort((a, b) => b - a);
      return score(5, fr[0], fr[1], fr[2], fr[3], fr[4]);
    }
    const sh = straightHigh(uniq);
    if (sh) return score(4, sh);
    if (trip) {
      const k = uniq.filter((r) => r !== trip);
      return score(3, trip, k[0], k[1]);
    }
    if (pair && pair2) {
      const k = uniq.filter((r) => r !== pair && r !== pair2);
      return score(2, pair, pair2, k[0]);
    }
    if (pair) {
      const k = uniq.filter((r) => r !== pair);
      return score(1, pair, k[0], k[1], k[2]);
    }
    return score(0, uniq[0], uniq[1], uniq[2], uniq[3], uniq[4]);
  }

  /** 표시용: 최고 5장 조합과 점수 (7장 → 21조합 비교) */
  function bestFive(cards) {
    if (cards.length <= 5) return { score: evaluate(cards), cards: cards.slice() };
    let bs = -1, bc = null;
    const n = cards.length;
    const idx = [0, 1, 2, 3, 4];
    const combo = new Array(5);
    (function rec(start, depth) {
      if (depth === 5) {
        for (let i = 0; i < 5; i++) combo[i] = cards[idx[i]];
        const s = evaluate(combo);
        if (s > bs) { bs = s; bc = combo.slice(); }
        return;
      }
      for (let i = start; i < n; i++) { idx[depth] = i; rec(i + 1, depth + 1); }
    })(0, 0);
    return { score: bs, cards: bc };
  }

  const catInfo = (sc) => CATS[catOf(sc)];

  /** 사람이 읽는 족보 이름 (킥커 포함하지 않는 간단형) */
  function handName(sc) {
    const c = catOf(sc);
    const t1 = Math.floor(sc / P4) % 15;
    const info = CATS[c];
    if (c === 9) return info.ko;
    if (c === 8 || c === 4) return rankName(t1) + ' 하이 ' + info.ko;
    if (c === 7 || c === 6 || c === 3 || c === 1) return rankName(t1) + ' ' + info.ko;
    if (c === 2) return rankName(t1) + '/' + rankName(Math.floor(sc / P3) % 15) + ' ' + info.ko;
    if (c === 5) return rankName(t1) + ' 하이 ' + info.ko;
    return rankName(t1) + ' 하이';
  }

  /* ───────── 확률 계산 ───────── */

  function remainingDeck(known) {
    const used = new Array(60).fill(false);
    known.forEach((c) => { if (c) used[cardId(c)] = true; });
    const d = [];
    for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) if (!used[r * 4 + s]) d.push({ r, s });
    return d;
  }

  /** 몬테카를로 승률: 내 핸드가 상대 nOpp명 상대로 이길/비길 확률 */
  function equity(hole, board, nOpp, iters) {
    const deck = remainingDeck(hole.concat(board));
    const need = 5 - board.length;
    let win = 0, tie = 0;
    const my = new Array(7);
    const op = new Array(7);
    for (let it = 0; it < iters; it++) {
      // 필요한 만큼만 부분 셔플
      const take = need + nOpp * 2;
      for (let i = 0; i < take; i++) {
        const j = i + ((Math.random() * (deck.length - i)) | 0);
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
      }
      let p = 0;
      const full = board.slice();
      for (let i = 0; i < need; i++) full.push(deck[p++]);
      for (let i = 0; i < 2; i++) my[i] = hole[i];
      for (let i = 0; i < 5; i++) my[2 + i] = full[i];
      const ms = evaluate(my);
      let best = -1, tied = 0;
      for (let o = 0; o < nOpp; o++) {
        op[0] = deck[p++]; op[1] = deck[p++];
        for (let i = 0; i < 5; i++) op[2 + i] = full[i];
        const os = evaluate(op);
        if (os > best) { best = os; tied = 1; }
        else if (os === best) tied++;
      }
      if (ms > best) win++;
      else if (ms === best) tie += 1 / (tied + 1);
    }
    return (win + tie) / iters;
  }

  /**
   * 앞으로 만들 수 있는 족보 분포 (남은 보드 카드를 전수 열거)
   * 리버면 현재 확정. 반환: {dist: [{cat, p}], bestCat, curCat}
   */
  function outlook(hole, board) {
    const cur = evaluate(hole.concat(board));
    const need = 5 - board.length;
    const counts = new Array(10).fill(0);
    if (need <= 0) {
      counts[catOf(cur)] = 1;
      return { dist: counts.map((p, cat) => ({ cat, p })).filter((x) => x.p > 0), curCat: catOf(cur), total: 1 };
    }
    const deck = remainingDeck(hole.concat(board));
    let total = 0;
    const buf = new Array(7);
    buf[0] = hole[0]; buf[1] = hole[1];
    for (let i = 0; i < board.length; i++) buf[2 + i] = board[i];
    if (need === 1) {
      for (let i = 0; i < deck.length; i++) {
        buf[6] = deck[i];
        counts[catOf(evaluate(buf))]++; total++;
      }
    } else {
      for (let i = 0; i < deck.length; i++) {
        buf[5] = deck[i];
        for (let j = i + 1; j < deck.length; j++) {
          buf[6] = deck[j];
          counts[catOf(evaluate(buf))]++; total++;
        }
      }
    }
    return {
      dist: counts.map((c, cat) => ({ cat, p: c / total })).filter((x) => x.p > 0).sort((a, b) => b.cat - a.cat),
      curCat: catOf(cur),
      total,
    };
  }

  /** 아웃츠: 다음 한 장으로 현재보다 족보 등급이 올라가는 카드 수 */
  function outs(hole, board) {
    if (board.length >= 5) return { n: 0, cards: [] };
    const curCat = catOf(evaluate(hole.concat(board)));
    const deck = remainingDeck(hole.concat(board));
    const buf = hole.concat(board);
    const hit = [];
    for (let i = 0; i < deck.length; i++) {
      if (catOf(evaluate(buf.concat([deck[i]]))) > curCat) hit.push(deck[i]);
    }
    return { n: hit.length, cards: hit };
  }

  /**
   * 지금 이 보드에서 상대가 가질 수 있는 2장 조합 중 나를 이기는 비율.
   * 남은 카드로 만들 수 있는 모든 조합(보통 990개)을 전수 계산한다.
   * 반환: {total, beat, tie, cats:{카테고리:건수}}
   */
  function beatingHands(hole, board) {
    if (board.length < 3) return null;
    const my = evaluate(hole.concat(board));
    const deck = remainingDeck(hole.concat(board));
    const buf = new Array(2 + board.length);
    for (let i = 0; i < board.length; i++) buf[2 + i] = board[i];
    const cats = {};
    let total = 0, beat = 0, tie = 0;
    for (let i = 0; i < deck.length; i++) {
      buf[0] = deck[i];
      for (let j = i + 1; j < deck.length; j++) {
        buf[1] = deck[j];
        const os = evaluate(buf);
        total++;
        if (os > my) { beat++; const c = catOf(os); cats[c] = (cats[c] || 0) + 1; }
        else if (os === my) tie++;
      }
    }
    return { total, beat, tie, cats, myScore: my };
  }

  /** 보드 위험 요소 (플러시/스트레이트/페어 가능성) */
  function boardTexture(board) {
    if (!board.length) return { flush: 0, paired: false, trips: false, straight: 0, notes: [] };
    const suit = [0, 0, 0, 0], rank = new Array(15).fill(0);
    board.forEach((c) => { suit[c.s]++; rank[c.r]++; });
    const flush = Math.max.apply(null, suit);
    const paired = rank.some((n) => n >= 2);
    const trips = rank.some((n) => n >= 3);
    // 스트레이트 근접도: 5칸 창 안에 서로 다른 랭크가 몇 개 있는지 (A는 1로도 계산)
    const present = new Array(15).fill(false);
    board.forEach((c) => { present[c.r] = true; if (c.r === 14) present[1] = true; });
    let straight = 0;
    for (let lo = 1; lo <= 10; lo++) {
      let n = 0;
      for (let k = 0; k < 5; k++) if (present[lo + k]) n++;
      if (n > straight) straight = n;
    }
    const notes = [];
    if (flush >= 4) notes.push('플러시 완성 가능성 높음');
    else if (flush === 3) notes.push('플러시 드로우 경계');
    if (trips) notes.push('보드 트리플, 포카드·풀하우스 주의');
    else if (paired) notes.push('보드 페어, 풀하우스 주의');
    if (straight >= 4) notes.push('스트레이트 완성 가능성 높음');
    else if (straight === 3 && board.length >= 3) notes.push('스트레이트 드로우 경계');
    return { flush, paired, trips, straight, notes };
  }

  /** 프리플랍 스타팅 핸드 분류 */
  function handClass(hole) {
    const a = hole[0].r >= hole[1].r ? hole[0] : hole[1];
    const b = hole[0].r >= hole[1].r ? hole[1] : hole[0];
    const pair = a.r === b.r, suited = a.s === b.s;
    const label = pair ? rankName(a.r) + rankName(b.r)
      : rankName(a.r) + rankName(b.r) + (suited ? 's' : 'o');
    const gap = a.r - b.r;
    let tier;
    if (pair && a.r >= 12) tier = 'S';
    else if (a.r === 14 && b.r === 13 && suited) tier = 'S';
    else if (pair && a.r >= 9) tier = 'A';
    else if (a.r === 14 && b.r >= 12) tier = 'A';
    else if (suited && a.r === 14 && b.r >= 11) tier = 'A';
    else if (suited && a.r >= 13 && b.r >= 12) tier = 'A';
    else if (pair) tier = 'B';
    else if (a.r === 14) tier = suited ? 'B' : (b.r >= 10 ? 'B' : 'C');
    else if (suited && gap <= 2 && b.r >= 7) tier = 'B';
    else if (a.r >= 12 && b.r >= 10) tier = 'B';
    else if (suited && gap <= 3) tier = 'C';
    else if (gap <= 2 && b.r >= 8) tier = 'C';
    else tier = 'D';
    return { label, pair, suited, gap, hi: a.r, lo: b.r, tier };
  }

  /** 사이드팟 구성: [{amt, eligible:[playerIndex]}] */
  function buildPots(players) {
    const levels = [...new Set(players.filter((p) => !p.folded && p.committed > 0).map((p) => p.committed))]
      .sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      let amt = 0;
      players.forEach((p) => { amt += Math.max(0, Math.min(p.committed, lv) - Math.min(p.committed, prev)); });
      const eligible = players.map((p, i) => (!p.folded && p.committed >= lv ? i : -1)).filter((i) => i >= 0);
      if (amt > 0) pots.push({ amt, eligible });
      prev = lv;
    }
    // 폴드한 플레이어가 최상위 레벨보다 더 넣은 잔액은 마지막 팟에 합산
    const totalCommitted = players.reduce((a, p) => a + p.committed, 0);
    const distributed = pots.reduce((a, p) => a + p.amt, 0);
    if (totalCommitted > distributed) {
      if (pots.length) pots[pots.length - 1].amt += totalCommitted - distributed;
      else pots.push({ amt: totalCommitted - distributed, eligible: players.map((p, i) => (!p.folded ? i : -1)).filter((i) => i >= 0) });
    }
    return pots;
  }

  const API = {
    SUIT_CH, CATS, newDeck, shuffle, evaluate, bestFive, catOf, catInfo, handName,
    rankName, cardName, cardId, remainingDeck, equity, outlook, outs, buildPots, straightHigh, score,
    beatingHands, boardTexture, handClass,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.HE = API;
})(typeof self !== 'undefined' ? self : this);
