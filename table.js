/**
 * table.js — 텍사스 홀덤 테이블 진행 로직 (UI 없음, 브라우저·Node 공용)
 *
 * index.html(혼자 연습)과 server.js(온라인)가 같은 코드를 쓴다.
 * 타이머는 여기 없다. 상태가 바뀌면 pending()이 "다음에 할 일"을 알려주고,
 * 호출하는 쪽(브라우저 또는 서버)이 원하는 간격으로 next()를 불러 진행시킨다.
 *
 *   pending() → 'human'   사람 차례(입력 대기)
 *               'bot'     봇 차례(next()로 진행)
 *               'stage'   액션 가능한 사람이 없어 다음 보드를 자동으로 깔 차례(next())
 *               'showdown' 핸드 종료(결과는 table.result), startHand()로 다음 핸드
 *               'over'    게임 종료(생존자 1명 이하)
 *               'idle'    아직 시작 전
 *
 * 이벤트: onEvent(type, data)
 *   'hand'   {handNo}                    새 핸드
 *   'action' {seat, name, act, cls}      누가 무엇을 했는지 (콜 100 / 레이즈 400 / 올인 ...)
 *   'stage'  {stage, cards}              플랍·턴·리버 공개
 *   'result' res                         쇼다운 결과
 *   'state'                              상태가 바뀜 (화면 갱신용)
 *   'gameover'
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./engine.js'));
  else root.TB = factory(root.HE);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (HE) {
  'use strict';

  const NAMES = [
    '해성', '병욱', '지석', '민서', '태현', '수아', '건우', '예린', '도윤', '지호',
    '서준', '하은', '시우', '유진', '준영', '다인', '성민', '채원', '재훈', '소율',
    '동현', '나은', '승우', '지안', '현우', '미르', '태윤', '은지', '우진', '세림',
  ];
  const ITERS = { easy: 120, normal: 420, hard: 900 };
  const STAGES = ['preflop', 'flop', 'turn', 'river', 'showdown'];
  const fmt = (n) => Math.round(n).toLocaleString('ko-KR');

  /** 봇 이름 뽑기 (이미 쓰는 이름 제외, 무작위) */
  function pickNames(n, used) {
    const pool = NAMES.filter((x) => !used.includes(x));
    for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    return pool.slice(0, n);
  }

  class Table {
    /**
     * @param cfg {stack, bb, diff}  — 객체를 그대로 참조한다(호출 쪽에서 바꾸면 즉시 반영).
     * @param onEvent (type, data, table) => void
     */
    constructor(cfg, onEvent) {
      this.cfg = cfg || {};
      if (this.cfg.stack == null) this.cfg.stack = 10000;
      if (this.cfg.bb == null) this.cfg.bb = 100;
      if (this.cfg.diff == null) this.cfg.diff = 'normal';
      this.onEvent = onEvent || (() => {});
      this.reset();
    }

    reset() {
      this.players = []; this.deck = []; this.board = []; this.stage = 'idle';
      this.btn = -1; this.toAct = -1; this.maxBet = 0; this.minRaise = 0;
      this.handNo = 0; this.log = []; this.showAll = false; this.auto = null; this.result = null;
    }

    get sb() { return Math.max(1, Math.floor(this.cfg.bb / 2)); }
    emit(type, data) { this.onEvent(type, data, this); }

    /* ───────── 좌석 ───────── */
    addPlayer(p) {
      const q = Object.assign({ id: this.players.length, name: '?', human: false, bot: false, stack: this.cfg.stack }, p);
      q.out = q.stack <= 0;
      this.resetPlayer(q);
      this.players.push(q);
      return q;
    }
    addBots(n) {
      const names = pickNames(n, this.players.map((p) => p.name));
      return names.map((name) => this.addPlayer({ name, human: false, bot: true }));
    }
    removePlayer(idx) {
      if (this.stage !== 'idle' && this.stage !== 'over') return false;
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => { p.id = i; });
      return true;
    }
    resetPlayer(p) {
      p.hole = []; p.bet = 0; p.committed = 0; p.folded = !!p.out; p.allIn = false; p.acted = false; p.last = ''; p.lastType = '';
    }

    /* ───────── 조회 ───────── */
    alive() { return this.players.filter((p) => !p.out); }
    inHand() { return this.players.filter((p) => !p.out && !p.folded); }
    canAct() { return this.inHand().filter((p) => !p.allIn); }
    potTotal() { return this.players.reduce((a, p) => a + p.committed, 0); }
    logLine(t, cls) { this.log.push({ t, cls }); if (this.log.length > 200) this.log.shift(); }
    nextAlive(from) {
      let i = from;
      for (let k = 0; k < this.players.length; k++) { i = (i + 1) % this.players.length; if (!this.players[i].out) return i; }
      return from;
    }
    nextActor(from) {
      let i = from;
      for (let k = 0; k < this.players.length; k++) {
        i = (i + 1) % this.players.length;
        const p = this.players[i];
        if (!p.out && !p.folded && !p.allIn) return i;
      }
      return -1;
    }
    roundDone() {
      const act = this.canAct();
      if (this.inHand().length <= 1) return true;
      if (act.length === 0) return true;
      return act.every((p) => p.acted && p.bet === this.maxBet);
    }
    pending() {
      if (this.auto) return this.auto;
      if (this.stage === 'showdown') return 'showdown';
      if (this.stage === 'over') return 'over';
      if (this.stage === 'idle') return 'idle';
      return this.toAct >= 0 ? 'human' : 'idle';
    }

    /* ───────── 핸드 시작 ───────── */
    startHand() {
      this.players.forEach((p) => { if (p.stack <= 0) p.out = true; });
      const alive = this.alive();
      if (alive.length < 2) { this.stage = 'over'; this.toAct = -1; this.auto = null; this.emit('gameover'); this.emit('state'); return false; }

      this.handNo++; this.result = null;
      this.board = []; this.stage = 'preflop'; this.showAll = false; this.maxBet = 0; this.minRaise = this.cfg.bb;
      this.deck = HE.shuffle(HE.newDeck());
      this.players.forEach((p) => { this.resetPlayer(p); p.handStart = p.stack; });
      do { this.btn = (this.btn + 1) % this.players.length; } while (this.players[this.btn].out);
      alive.forEach((p) => { p.hole = [this.deck.pop(), this.deck.pop()]; });

      this.logLine('핸드 #' + this.handNo, 'hd');
      const sbIdx = alive.length === 2 ? this.btn : this.nextAlive(this.btn);
      const bbIdx = this.nextAlive(sbIdx);
      this.postBlind(sbIdx, this.sb, 'SB');
      this.postBlind(bbIdx, this.cfg.bb, 'BB');
      this.maxBet = this.cfg.bb; this.minRaise = this.cfg.bb;
      this.players.forEach((p) => { p.acted = false; });
      this.toAct = this.nextActor(bbIdx);
      this.emit('hand', { handNo: this.handNo });
      this.settle();
      return true;
    }
    postBlind(i, amt, tag) {
      const p = this.players[i];
      const a = Math.min(amt, p.stack);
      p.stack -= a; p.bet += a; p.committed += a;
      if (p.stack === 0) p.allIn = true;
      p.last = tag + ' ' + fmt(a); p.lastType = 'blind';
    }

    /** 상태 변경 후 다음에 할 일 결정 */
    settle() {
      if (this.stage === 'showdown' || this.stage === 'over' || this.stage === 'idle') { this.auto = null; this.emit('state'); return; }
      if (this.inHand().length <= 1) return this.endHand();
      if (this.roundDone()) { this.auto = 'stage'; this.emit('state'); return; }
      if (this.toAct < 0) this.toAct = this.nextActor(this.btn);
      const p = this.players[this.toAct];
      this.auto = p.human ? null : 'bot';
      this.emit('state');
    }

    /** 자동 진행 한 단계 (봇 액션 또는 다음 보드) */
    next() {
      const a = this.auto;
      if (a === 'bot') { this.auto = null; return this.botAct(this.toAct); }
      if (a === 'stage') { this.auto = null; return this.nextStage(); }
      return false;
    }

    /* ───────── 진행 ───────── */
    nextStage() {
      this.players.forEach((p) => { p.bet = 0; p.acted = false; p.last = ''; p.lastType = ''; });
      this.maxBet = 0; this.minRaise = this.cfg.bb;
      const next = STAGES[STAGES.indexOf(this.stage) + 1];
      this.stage = next;
      if (next === 'flop') { this.deck.pop(); this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.logLine('플랍: ' + this.board.map(HE.cardName).join(' ')); this.emit('stage', { stage: 'flop', cards: this.board.slice(0, 3) }); }
      else if (next === 'turn') { this.deck.pop(); this.board.push(this.deck.pop()); this.logLine('턴: ' + HE.cardName(this.board[3])); this.emit('stage', { stage: 'turn', cards: [this.board[3]] }); }
      else if (next === 'river') { this.deck.pop(); this.board.push(this.deck.pop()); this.logLine('리버: ' + HE.cardName(this.board[4])); this.emit('stage', { stage: 'river', cards: [this.board[4]] }); }
      else return this.endHand();

      // 액션 가능한 사람이 1명 이하면 남은 보드를 자동으로 깐다
      if (this.canAct().length <= 1) { this.toAct = -1; this.auto = 'stage'; this.emit('state'); return true; }
      this.toAct = this.nextActor(this.btn);
      this.auto = this.players[this.toAct].human ? null : 'bot';
      this.emit('state');
      return true;
    }

    /** 액션. 반환값 false = 거부(차례 아님 등) */
    doAction(i, type, amount) {
      const p = this.players[i];
      if (!p || this.stage === 'idle' || this.stage === 'showdown' || this.stage === 'over') return false;
      if (i !== this.toAct || p.folded || p.allIn || p.out) return false;
      const toCall = this.maxBet - p.bet;
      let act = '', cls = '';
      if (type === 'fold') { p.folded = true; act = '폴드'; cls = 'fold'; this.logLine(p.name + ' 폴드'); }
      else if (type === 'check') {
        if (toCall > 0) return false;
        act = '체크'; cls = 'check'; this.logLine(p.name + ' 체크');
      } else if (type === 'call') {
        if (toCall <= 0) return this.doAction(i, 'check');
        const a = Math.min(toCall, p.stack);
        p.stack -= a; p.bet += a; p.committed += a;
        if (p.stack === 0) { p.allIn = true; act = '올인 ' + fmt(a); cls = 'allin'; this.logLine(p.name + ' 콜 올인 ' + fmt(a)); }
        else { act = '콜 ' + fmt(a); cls = 'call'; this.logLine(p.name + ' 콜 ' + fmt(a)); }
      } else if (type === 'raise') {
        const maxTo = p.bet + p.stack;
        let target = Math.min(Math.round(+amount || 0), maxTo);
        const minTo = Math.min(this.maxBet + this.minRaise, maxTo);
        if (target < minTo) target = minTo;              // 최소 레이즈 미만은 최소 레이즈로 보정(올인이면 그대로)
        if (target <= this.maxBet && target < maxTo) return this.doAction(i, toCall > 0 ? 'call' : 'check');
        const add = target - p.bet;
        p.stack -= add; p.bet += add; p.committed += add;
        const raiseBy = target - this.maxBet;
        if (raiseBy > 0) {
          this.minRaise = Math.max(this.minRaise, raiseBy);
          this.maxBet = target;
          this.players.forEach((q) => { if (q !== p && !q.folded && !q.allIn && !q.out) q.acted = false; });
        }
        if (p.stack === 0) { p.allIn = true; act = '올인 ' + fmt(target); cls = 'allin'; this.logLine(p.name + ' 올인 ' + fmt(target)); }
        else { const word = toCall > 0 ? '레이즈' : '벳'; act = word + ' ' + fmt(target); cls = 'raise'; this.logLine(p.name + ' ' + word + ' ' + fmt(target)); }
      } else return false;

      p.last = act; p.lastType = cls; p.acted = true;
      this.emit('action', { seat: i, name: p.name, act, cls });

      if (this.inHand().length <= 1) { this.endHand(); return true; }
      if (this.roundDone()) { this.nextStage(); return true; }
      this.toAct = this.nextActor(i);
      this.auto = this.players[this.toAct].human ? null : 'bot';
      this.emit('state');
      return true;
    }

    /* ───────── 봇 ───────── */
    botAct(i) {
      const p = this.players[i];
      if (!p || p.folded || p.allIn || p.out || i !== this.toAct) { this.toAct = this.nextActor(this.toAct); this.settle(); return false; }
      const diff = this.cfg.diff || 'normal';
      const opp = Math.max(1, this.inHand().length - 1);
      const toCall = this.maxBet - p.bet;
      const pot = this.potTotal();
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      let eq = HE.equity(p.hole, this.board, opp, ITERS[diff] || 420);
      const R = Math.random();
      const bluff = diff === 'easy' ? 0.03 : diff === 'normal' ? 0.10 : 0.18;
      if (diff === 'hard') {
        const seatsAfter = (i - this.btn + this.players.length) % this.players.length;
        eq += seatsAfter <= 1 ? 0.03 : -0.02;
        if (opp >= 3) eq -= 0.04;
      }
      if (diff === 'easy') eq = eq * 0.75 + 0.18;
      const bb = this.cfg.bb;
      const potBet = Math.max(bb, Math.round(pot * (diff === 'hard' ? (R < 0.3 ? 0.75 : 0.5) : 0.6) / bb) * bb);
      const raiseTo = Math.min(p.bet + p.stack, this.maxBet + Math.max(this.minRaise, potBet));
      if (toCall === 0) {
        const betThreshold = diff === 'easy' ? 0.72 : diff === 'normal' ? 0.60 : 0.55;
        if (eq > betThreshold && R < 0.82) return this.doAction(i, 'raise', raiseTo);
        if (R < bluff && this.stage !== 'preflop') return this.doAction(i, 'raise', raiseTo);
        return this.doAction(i, 'check');
      }
      const need = potOdds * (diff === 'easy' ? 0.62 : diff === 'normal' ? 0.95 : 1.05);
      const raiseThreshold = diff === 'easy' ? 0.80 : diff === 'normal' ? 0.68 : 0.62;
      if (eq > raiseThreshold && R < 0.7 && p.stack > toCall) return this.doAction(i, 'raise', raiseTo);
      if (eq >= need) return this.doAction(i, 'call');
      if (R < bluff * 0.5 && p.stack > toCall * 3) return this.doAction(i, 'raise', raiseTo);
      return this.doAction(i, 'fold');
    }

    /* ───────── 핸드 종료 ───────── */
    endHand() {
      this.stage = 'showdown'; this.auto = null;
      const live = this.inHand();
      const res = { winners: [], winnerSeats: [], hand: '', cards: [], allFolded: false, rows: [], pots: [] };
      if (live.length === 1) {
        const w = live[0];
        const amt = this.potTotal();
        w.stack += amt;
        res.winners = [w.name]; res.winnerSeats = [this.players.indexOf(w)]; res.allFolded = true;
        this.logLine(w.name + ' 승리 ' + fmt(amt) + ' (모두 폴드)', 'win');
      } else {
        this.showAll = true;
        while (this.board.length < 5) { this.deck.pop(); this.board.push(this.deck.pop()); }
        const scores = this.players.map((p) => (!p.out && !p.folded ? HE.bestFive(p.hole.concat(this.board)) : null));
        const pots = HE.buildPots(this.players);
        pots.forEach((pot, pi) => {
          let best = -1, winners = [];
          pot.eligible.forEach((idx) => {
            const s = scores[idx] ? scores[idx].score : -1;
            if (s > best) { best = s; winners = [idx]; }
            else if (s === best) winners.push(idx);
          });
          const share = Math.floor(pot.amt / winners.length);
          winners.forEach((idx) => { this.players[idx].stack += share; });
          // 나눠떨어지지 않는 칩은 버튼 다음 자리부터 1칩씩 (표준 규칙)
          let rem = pot.amt - share * winners.length;
          if (rem > 0) {
            const n = this.players.length;
            const order = winners.slice().sort((a, b) => ((a - this.btn + n) % n) - ((b - this.btn + n) % n));
            for (let k = 0; rem > 0; k++, rem--) this.players[order[k % order.length]].stack += 1;
          }
          const label = pots.length > 1 ? (pi === 0 ? '메인팟' : '사이드팟' + pi) + ' ' : '';
          this.logLine(label + winners.map((x) => this.players[x].name).join(', ') + ' 승리 ' + fmt(share) + ' (' + HE.handName(best) + ')', 'win');
          res.pots.push({ amt: pot.amt, winners: winners.slice(), hand: HE.handName(best) });
          if (pi === 0) {
            res.winners = winners.map((x) => this.players[x].name);
            res.winnerSeats = winners.slice();
            res.hand = HE.handName(best);
            res.cards = scores[winners[0]] ? scores[winners[0]].cards : [];
          }
        });
        res.rows = this.players.map((p, idx) => (!p.out && !p.folded && scores[idx]
          ? { seat: idx, name: p.name, score: scores[idx].score, hand: HE.handName(scores[idx].score), cards: scores[idx].cards, hole: p.hole }
          : null)).filter(Boolean).sort((a, b) => b.score - a.score);
        const topScore = res.rows.length ? res.rows[0].score : 0;
        res.rows.forEach((r) => { r.win = r.score === topScore; });
        this.players.forEach((p, idx) => {
          if (!p.out && !p.folded) this.logLine('  ' + p.name + ': ' + p.hole.map(HE.cardName).join(' ') + ' → ' + HE.handName(scores[idx].score));
        });
      }
      this.toAct = -1;
      this.result = res;
      this.emit('result', res);
      this.emit('state');
      return true;
    }

    /* ───────── 좌석별 화면 상태 ───────── */
    /**
     * seat 기준으로 자리를 돌려(내가 0번) 자기 패만 보이는 상태를 만든다.
     * 온라인에서는 서버가 각 접속자에게 이걸 보낸다. 덱은 절대 포함하지 않는다.
     */
    view(seat) {
      const n = this.players.length;
      const rot = (i) => (i < 0 || n === 0 ? -1 : (i - seat + n) % n);
      const players = [];
      for (let k = 0; k < n; k++) {
        const p = this.players[(seat + k) % n];
        const reveal = k === 0 || (this.showAll && !p.folded);
        players.push({
          id: p.id, name: p.name, human: p.human, bot: !!p.bot, online: p.online !== false,
          stack: p.stack, bet: p.bet, committed: p.committed, folded: p.folded, allIn: p.allIn, out: p.out,
          acted: p.acted, last: p.last, lastType: p.lastType, handStart: p.handStart,
          hole: reveal ? p.hole.slice() : p.hole.map(() => null),
        });
      }
      let result = null;
      if (this.result) {
        result = Object.assign({}, this.result, {
          rows: this.result.rows.map((r) => Object.assign({}, r, { isMe: r.seat === seat })),
          iWon: this.result.winnerSeats.indexOf(seat) >= 0,
        });
      }
      return {
        seat, players, board: this.board.slice(), stage: this.stage, btn: rot(this.btn), toAct: rot(this.toAct),
        maxBet: this.maxBet, minRaise: this.minRaise, handNo: this.handNo, showAll: this.showAll,
        log: this.log.slice(-60), cfg: { stack: this.cfg.stack, bb: this.cfg.bb, diff: this.cfg.diff },
        pending: this.pending(), result,
      };
    }
  }

  return { Table, NAMES, pickNames };
});
