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
 *               'paused'  자리 비움 등으로 칠 수 있는 사람이 1명뿐이라 대기 중 (돌아오면 startHand)
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
      return names.map((name) => this.addPlayer({ name, human: false, bot: true, style: Table.styleFor(this.cfg.diff) }));
    }
    removePlayer(idx) {
      if (this.stage !== 'idle' && this.stage !== 'over' && this.stage !== 'paused') return false;
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => { p.id = i; });
      return true;
    }
    resetPlayer(p) {
      p.hole = []; p.bet = 0; p.committed = 0; p.folded = !!(p.out || p.sitOut); p.allIn = false; p.acted = false; p.last = ''; p.lastType = ''; p.aggressor = false;
    }

    /* ───────── 조회 ───────── */
    alive() { return this.players.filter((p) => !p.out); }
    /** 이번 핸드에 카드를 받을 사람 (탈락·자리 비움 제외) */
    dealable() { return this.players.filter((p) => !p.out && !p.sitOut); }
    inHand() { return this.players.filter((p) => !p.out && !p.folded); }
    canAct() { return this.inHand().filter((p) => !p.allIn); }
    potTotal() { return this.players.reduce((a, p) => a + p.committed, 0); }
    logLine(t, cls) { this.log.push({ t, cls }); if (this.log.length > 200) this.log.shift(); }
    nextAlive(from) {
      let i = from;
      for (let k = 0; k < this.players.length; k++) { i = (i + 1) % this.players.length; if (!this.players[i].out && !this.players[i].sitOut) return i; }
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
      if (this.stage === 'paused') return 'paused';
      if (this.stage === 'idle') return 'idle';
      return this.toAct >= 0 ? 'human' : 'idle';
    }

    /* ───────── 핸드 시작 ───────── */
    startHand() {
      this.players.forEach((p) => { if (p.stack <= 0) p.out = true; });
      if (this.alive().length < 2) { this.stage = 'over'; this.toAct = -1; this.auto = null; this.emit('gameover'); this.emit('state'); return false; }
      const alive = this.dealable();
      if (alive.length < 2) { this.stage = 'paused'; this.toAct = -1; this.auto = null; this.board = []; this.players.forEach((p) => this.resetPlayer(p)); this.emit('state'); return false; }   // 자리 비움으로 대기

      this.handNo++; this.result = null;
      this.board = []; this.stage = 'preflop'; this.showAll = false; this.maxBet = 0; this.minRaise = this.cfg.bb;
      this.deck = HE.shuffle(HE.newDeck());
      this.players.forEach((p) => { this.resetPlayer(p); p.handStart = p.stack; });
      do { this.btn = (this.btn + 1) % this.players.length; } while (this.players[this.btn].out || this.players[this.btn].sitOut);
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
      if (this.stage === 'showdown' || this.stage === 'over' || this.stage === 'idle' || this.stage === 'paused') { this.auto = null; this.emit('state'); return; }
      if (this.inHand().length <= 1) return this.endHand();
      if (this.roundDone()) { this.toAct = -1; this.auto = 'stage'; this.emit('state'); return; }   // 자동 진행 대기 중엔 아무도 액션 불가
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
    /** 핸드가 진행 중인 스테이지인지 */
    get live() { return this.stage === 'preflop' || this.stage === 'flop' || this.stage === 'turn' || this.stage === 'river'; }

    /* ───────── 진행 ───────── */
    nextStage() {
      if (!this.live) return false;                                  // 쇼다운·종료 뒤 늦게 도착한 자동 진행은 무시
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
      if (!p || !this.live || this.auto) return false;               // 진행 중이 아니거나 자동 진행 대기 중이면 거부
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
    /**
     * 봇 성향. 난이도를 고르면 모든 봇이 같은 성향, '섞기'는 봇마다 다르게 배정된다.
     *   aggr  강한 손으로 베팅/레이즈하는 빈도    bluff 약한 손으로 베팅하는 빈도
     *   stub  콜 기준 배율(클수록 잘 접음, 1보다 작으면 콜링스테이션)   cbet  프리플랍 공격자가 플랍에 이어서 베팅하는 빈도
     *   trap  아주 강할 때 체크로 숨기는 빈도       noise 엉뚱한 실수 빈도
     *   range 프리플랍에서 참여하는 손 (위치별)     iters 승률 계산 정밀도
     */
    static get STYLES() {
      return {
        easy:   { label: '초급',  aggr: 0.15, bluff: 0.03, stub: 0.62, cbet: 0.20, trap: 0.00, noise: 0.25, size: 0.5, iters: 120,  range: { early: 'SABCD', late: 'SABCD', blind: 'SABCD' }, raise: 'S', threebet: '' },
        normal: { label: '중급',  aggr: 0.45, bluff: 0.10, stub: 0.95, cbet: 0.50, trap: 0.10, noise: 0.10, size: 0.6, iters: 420,  range: { early: 'SABC', late: 'SABC', blind: 'SABCD' }, raise: 'SA', threebet: 'S' },
        hard:   { label: '고수',  aggr: 0.65, bluff: 0.16, stub: 1.05, cbet: 0.65, trap: 0.20, noise: 0.06, size: 0.7, iters: 900,  range: { early: 'SAB', late: 'SABC', blind: 'SABC' }, raise: 'SAB', threebet: 'SA' },
        pro:    { label: '프로',  aggr: 0.80, bluff: 0.20, stub: 1.10, cbet: 0.75, trap: 0.30, noise: 0.03, size: 0.75, iters: 1200, range: { early: 'SAB', late: 'SABC', blind: 'SABC' }, raise: 'SAB', threebet: 'SA' },
        maniac: { label: '공격형', aggr: 0.90, bluff: 0.35, stub: 0.75, cbet: 0.90, trap: 0.05, noise: 0.10, size: 1.0, iters: 700,  range: { early: 'SABC', late: 'SABCD', blind: 'SABCD' }, raise: 'SABC', threebet: 'SAB' },
        rock:   { label: '수비형', aggr: 0.35, bluff: 0.02, stub: 1.25, cbet: 0.40, trap: 0.35, noise: 0.05, size: 0.6, iters: 900,  range: { early: 'SA', late: 'SAB', blind: 'SAB' }, raise: 'SA', threebet: 'S' },
      };
    }
    static styleFor(diff) {
      const S = Table.STYLES;
      if (diff === 'mix') { const pool = ['normal', 'hard', 'pro', 'maniac', 'rock']; return pool[(Math.random() * pool.length) | 0]; }
      return S[diff] ? diff : 'normal';
    }

    /** 위치: 0=버튼, 1=SB, 2=BB, 그 뒤가 앞자리(early) */
    position(i) {
      const n = this.alive().length;
      const order = [];
      let k = this.btn;
      for (let c = 0; c < this.players.length; c++) { if (!this.players[k].out) order.push(k); k = (k + 1) % this.players.length; }
      const pos = order.indexOf(i);           // 0=버튼 … n-1=버튼 바로 앞(컷오프)
      if (n <= 3) return pos === 0 ? 'late' : 'blind';
      if (pos === 1 || pos === 2) return 'blind';
      if (pos === 0 || pos === n - 1) return 'late';
      return 'early';
    }

    botAct(i) {
      const p = this.players[i];
      if (!this.live) return false;
      if (!p || p.folded || p.allIn || p.out || i !== this.toAct) { this.toAct = this.nextActor(this.toAct); this.settle(); return false; }
      const st = Table.STYLES[p.style] || Table.STYLES[Table.styleFor(this.cfg.diff)];
      const R = Math.random;
      const bb = this.cfg.bb;
      const opp = Math.max(1, this.inHand().length - 1);
      const toCall = this.maxBet - p.bet;
      const pot = this.potTotal();
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      const maxTo = p.bet + p.stack;
      const short = p.stack + p.bet <= bb * 10;                       // 짧은 스택: 밀거나 접거나
      const act = (type, amount) => {
        if (type === 'check' && toCall > 0) type = 'call';
        if (type === 'raise' && (amount == null || amount <= this.maxBet)) type = toCall > 0 ? 'call' : 'check';
        return this.doAction(i, type, amount);
      };
      const raiseTo = (frac) => {                                      // 팟 대비 크기로 레이즈 목표 계산
        const size = Math.max(this.minRaise, Math.round((pot + toCall) * frac / bb) * bb, bb);
        return Math.min(maxTo, this.maxBet + size);
      };
      // 실수(노이즈): 가끔 엉뚱하게 콜하거나 접는다
      if (R() < st.noise) return act(toCall > 0 ? (R() < 0.6 ? 'call' : 'fold') : 'check');

      /* ── 프리플랍: 손 등급과 위치로 참여 여부 ── */
      if (this.stage === 'preflop') {
        const hc = HE.handClass(p.hole);
        const pos = this.position(i);
        const playable = st.range[pos].includes(hc.tier);
        const raised = this.maxBet > bb;                               // 누군가 이미 레이즈
        const bigRaise = this.maxBet >= bb * 4;
        if (short) {                                                   // 짧은 스택: 좋은 손이면 올인, 아니면 접기(공짜면 체크)
          if ('SA'.includes(hc.tier) || (hc.tier === 'B' && !bigRaise)) return act('raise', maxTo);
          return act(toCall > 0 ? 'fold' : 'check');
        }
        if (!playable) return act(toCall > 0 ? 'fold' : 'check');
        if (!raised) {
          if (st.raise.includes(hc.tier) && R() < st.aggr + 0.15) { p.aggressor = true; return act('raise', raiseTo(R() < 0.5 ? 0.8 : 1.0)); }
          return act(toCall > 0 ? 'call' : 'check');
        }
        // 레이즈에 맞서서: 3벳 손이면 다시 올리고, 참여 손이면 콜, 너무 크면 접기
        if (st.threebet.includes(hc.tier) && R() < st.aggr) { p.aggressor = true; return act('raise', raiseTo(1.0)); }
        if (bigRaise && !'SA'.includes(hc.tier) && R() < 0.75) return act('fold');
        if (hc.tier === 'S' && R() < 0.6) { p.aggressor = true; return act('raise', raiseTo(1.0)); }
        return act('call');
      }

      /* ── 플랍 이후: 승률·아웃츠·보드 상태 ── */
      let eq = HE.equity(p.hole, this.board, opp, st.iters);
      const ou = HE.outs(p.hole, this.board);
      const left = 5 - this.board.length;
      const drawP = ou.n && left ? Math.min(0.9, ou.n * (left >= 2 ? 4 : 2) / 100) : 0;
      const draw = ou.n >= 8 && left > 0;                              // 플러시·양방 스트레이트급 드로우
      const tex = HE.boardTexture(this.board);
      const wet = tex.flush >= 3 || tex.straight >= 3;
      const sizeFrac = wet ? Math.min(1.0, st.size + 0.25) : st.size;
      if (opp >= 3) eq -= 0.03;

      if (toCall === 0) {
        // 아주 강함: 가끔 트랩(체크), 아니면 베팅
        if (eq > 0.80) { if (R() < st.trap && this.canAct().length > 1) return act('check'); return act('raise', raiseTo(sizeFrac)); }
        if (eq > 0.62 && R() < st.aggr + 0.1) return act('raise', raiseTo(sizeFrac));
        if (p.aggressor && this.stage === 'flop' && eq > 0.35 && R() < st.cbet) return act('raise', raiseTo(0.55));   // 컨티뉴 벳
        if (draw && R() < st.aggr * 0.6) return act('raise', raiseTo(0.6));                                            // 세미블러프
        if (!draw && eq < 0.4 && R() < st.bluff && this.stage !== 'river') return act('raise', raiseTo(0.6));         // 순수 블러프
        return act('check');
      }

      // 콜이 필요한 상황
      const need = potOdds * st.stub;
      const raiseEq = p.style === 'pro' || p.style === 'maniac' ? 0.60 : 0.68;
      if (short) { if (eq > 0.5 || (draw && drawP >= 0.3)) return act('raise', maxTo); return act('fold'); }
      if (eq > raiseEq && R() < st.aggr) return act('raise', raiseTo(sizeFrac));
      if (draw && drawP < potOdds && R() < st.bluff * 0.7 && p.stack > toCall * 4) return act('raise', raiseTo(0.8)); // 드로우로 되치기
      if (eq >= need) return act('call');
      if (draw && drawP >= potOdds * 0.85 && p.stack > toCall * 2) return act('call');                                // 아웃츠 콜
      if (R() < st.bluff * 0.3 && p.stack > toCall * 3 && this.stage !== 'river') return act('raise', raiseTo(0.8)); // 가끔 블러프 레이즈
      return act('fold');
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
          id: p.id, name: p.name, human: p.human, bot: !!p.bot, online: p.online !== false, style: p.style || '', styleLabel: p.style && Table.STYLES[p.style] ? Table.STYLES[p.style].label : '', away: p.away || '',
          stack: p.stack, bet: p.bet, committed: p.committed, folded: p.folded, allIn: p.allIn, out: p.out,
          acted: p.acted, last: p.last, lastType: p.lastType, handStart: p.handStart, sitOut: !!p.sitOut,
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
        log: this.log.slice(-60), cfg: { stack: this.cfg.stack, bb: this.cfg.bb, diff: this.cfg.diff, speed: this.cfg.speed },
        pending: this.pending(), result,
      };
    }
  }

  return { Table, NAMES, pickNames };
});
