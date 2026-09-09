/**
 * 온라인 서버 검증 (node test-net.js)
 * 서버를 임시 포트로 띄우고 사람 2명 + 봇 1명이 실제 WebSocket으로 여러 핸드를 친다.
 * 검증: 남의 패·덱 비노출, 칩 총량 보존, 토큰 재접속 복귀, 채팅 전달, 차례 제한 자동 처리, 게임 흐름 교착 없음.
 */
process.env.PORT = '0';
const { server, rooms } = require('./server.js');
const WebSocket = require('ws');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const c = { name, ws: null, code: '', seat: -1, token: '', host: false, views: [], lobby: null, chats: [], errors: [], clocks: 0, lastView: null, autoplay: true, acted: 0 };
  c.connect = (port) => new Promise((resolve) => {
    c.ws = new WebSocket('ws://127.0.0.1:' + port);
    c.ws.on('open', resolve);
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') { c.code = m.code; c.seat = m.seat; c.token = m.token; c.host = m.host; }
      else if (m.t === 'lobby') c.lobby = m;
      else if (m.t === 'state') { c.lastView = m.view; c.views.push(m.view); if (c.autoplay) c.maybeAct(m.view); }
      else if (m.t === 'chat') c.chats.push(m);
      else if (m.t === 'error') c.errors.push(m.msg);
      else if (m.t === 'turnclock') c.clocks++;
      else if (m.t === 'gameover') c.gameover = m;
    });
  });
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.maybeAct = (v) => {
    if (v.toAct !== 0 || v.stage === 'showdown' || v.stage === 'over' || v.stage === 'idle') return;
    const me = v.players[0];
    const toCall = v.maxBet - me.bet;
    const r = Math.random();
    let type = 'call', amount;
    if (toCall > 0 && r < 0.2) type = 'fold';
    else if (r < 0.8) type = toCall > 0 ? 'call' : 'check';
    else { type = 'raise'; amount = Math.min(me.bet + me.stack, v.maxBet + Math.max(v.minRaise, v.cfg.bb * 2)); }
    c.acted++;
    setTimeout(() => c.send({ t: 'act', type, amount }), 30);
  };
  return c;
}

/** 화면 상태 검사: 덱 없음, 남의 패는 쇼다운 공개 전엔 null, 칩 총량 */
function checkView(v, base, label) {
  ok(!('deck' in v), label + ': 덱이 화면 상태에 없음');
  const others = v.players.slice(1);
  const hidden = others.every((p) => p.hole.every((c) => c === null) || (v.showAll && !p.folded));
  ok(hidden, label + ': 남의 패 비노출 (stage=' + v.stage + ')');
  const total = v.players.reduce((a, p) => a + p.stack + p.committed, 0);
  ok(total === base, label + ': 칩 총량 ' + total + '/' + base);
}

(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  console.log('온라인 검증 (포트 ' + port + ')');

  const A = client('철수'), B = client('영희');
  await A.connect(port); A.send({ t: 'create', name: A.name }); await sleep(150);
  ok(A.code && /^\d{4}$/.test(A.code) && A.host, '방 생성 · 숫자 코드 ' + A.code);

  await B.connect(port); B.send({ t: 'join', code: A.code, name: B.name }); await sleep(150);
  ok(B.code === A.code && B.seat === 1 && !B.host, '참가 · 좌석 ' + B.seat);
  ok(A.lobby && A.lobby.players.length === 2, '로비에 2명');

  // 이름 중복 거부
  const C = client('영희'); await C.connect(port); C.send({ t: 'join', code: A.code, name: '영희' }); await sleep(150);
  ok(C.errors.length === 1, '같은 이름 참가 거부'); C.ws.close();

  // 방장만 봇 추가·시작
  B.send({ t: 'addBot' }); await sleep(100);
  ok(A.lobby.players.length === 2, '방장 아닌 사람의 봇 추가 무시');
  A.send({ t: 'addBot' }); await sleep(100);
  ok(A.lobby.players.length === 3 && A.lobby.players[2].bot, '봇 추가');
  B.send({ t: 'start', cfg: {} }); await sleep(100);
  ok(B.errors.some((e) => e.includes('방장')), '방장 아닌 사람의 시작 거부');

  // 채팅
  A.send({ t: 'chat', text: '안녕' }); B.send({ t: 'chat', text: '👍' }); await sleep(150);
  ok(B.chats.some((c) => c.name === '철수' && c.text === '안녕') && A.chats.some((c) => c.text === '👍'), '채팅·이모지 전달');

  // 시작
  const STACK = 5000, BASE = STACK * 3;
  A.send({ t: 'start', cfg: { stack: STACK, bb: 100, diff: 'normal', speed: 'fast', turn: 5 } }); await sleep(200);
  ok(A.lastView && A.lastView.stage === 'idle' && A.lastView.players.length === 3, '시작 전 테이블만 깔림(idle)');
  B.send({ t: 'deal' }); await sleep(100);
  ok(A.lastView.stage === 'idle', '방장 아닌 사람의 시작 무시');
  A.send({ t: 'deal' });
  const t0 = Date.now();
  while ((A.lastView ? A.lastView.handNo : 0) < 3 && Date.now() - t0 < 60000) await sleep(100);
  ok(A.lastView && A.lastView.handNo >= 3, '3핸드 이상 진행 (' + (A.lastView ? A.lastView.handNo : 0) + '핸드)');
  ok(A.acted > 0 && B.acted > 0, '두 사람 모두 액션 (' + A.acted + '/' + B.acted + ')');
  ok(A.clocks > 0, '차례 시계 수신');

  // 화면 상태 검사 (모든 수신 뷰)
  let deckLeak = 0, holeLeak = 0, chipBad = 0;
  for (const c of [A, B]) for (const v of c.views) {
    if ('deck' in v) deckLeak++;
    const leak = v.players.slice(1).some((p) => p.hole.some((x) => x !== null) && !(v.showAll && !p.folded));
    if (leak) holeLeak++;
    // 쇼다운 뒤에는 팟이 이미 승자 스택에 들어가 있고 committed는 다음 핸드까지 남아 있으므로 스택만 합산
    const total = v.players.reduce((a, p) => a + p.stack + (v.stage === 'showdown' ? 0 : p.committed), 0);
    if (v.stage !== 'idle' && total !== BASE) { chipBad++; if (chipBad === 1) console.log('  · 불일치 예: stage=' + v.stage + ' total=' + total); }
  }
  ok(deckLeak === 0, '덱 비노출 (' + (A.views.length + B.views.length) + '개 화면)');
  ok(holeLeak === 0, '남의 패 비노출');
  ok(chipBad === 0, '칩 총량 보존 ' + BASE);
  ok(A.lastView.seat === 0 && B.lastView.seat === 1 && A.lastView.players[0].name === '철수' && B.lastView.players[0].name === '영희', '각자 자기 좌석이 0번');

  // 재접속: B가 끊고 토큰으로 복귀
  B.autoplay = false; B.ws.close(); await sleep(300);
  ok(A.lobby.players.find((p) => p.name === '영희').online === false, '끊긴 사람 오프라인 표시');
  const B2 = client('영희'); await B2.connect(port); B2.send({ t: 'join', code: A.code, name: '영희', token: B.token }); await sleep(200);
  ok(B2.seat === 1 && B2.token === B.token, '토큰으로 같은 자리 복귀');
  ok(B2.lastView && B2.lastView.players[0].name === '영희', '복귀 후 화면 수신');

  // 차례 제한: B2가 액션을 안 하면 5초 뒤 자동 처리되어 진행돼야 함
  const h1 = A.lastView.handNo;
  const t1 = Date.now();
  while (Date.now() - t1 < 20000 && (A.lastView.handNo < h1 + 1)) await sleep(100);
  ok(A.lastView.handNo >= h1 + 1, '무응답 상대가 있어도 제한 시간 뒤 진행 (' + h1 + '→' + A.lastView.handNo + ')');
  ok(!B2.errors.length, '복귀 클라이언트 오류 없음' + (B2.errors.length ? ': ' + B2.errors.join(' | ') : ''));

  // 자리 비움: B2가 AI 대리로 두면 액션 없이도 핸드가 진행되고, 복귀하면 다시 차례가 온다
  B2.autoplay = false; B2.send({ t: 'away', mode: 'bot' }); await sleep(200);
  ok(A.lobby.players.find((p) => p.name === '영희').away === 'bot', '로비에 AI 대리 표시');
  const h2 = A.lastView.handNo, acted2 = B2.acted;
  const t2 = Date.now();
  while (Date.now() - t2 < 40000 && A.lastView.handNo < h2 + 2) await sleep(100);
  ok(A.lastView.handNo >= h2 + 2 && B2.acted === acted2, 'AI 대리 중 액션 없이 2핸드 진행 (' + h2 + '→' + A.lastView.handNo + ')');
  B2.send({ t: 'away', mode: '' }); await sleep(200);
  ok(A.lobby.players.find((p) => p.name === '영희').away === '', '복귀');

  // 방장 나가면 방장 이양
  B2.autoplay = true;
  A.send({ t: 'leave' }); await sleep(300);
  ok(B2.lobby && B2.lobby.host === true, '방장 이양');

  A.ws.close(); B2.ws.close();
  console.log(`\n통과 ${pass} / 실패 ${fail}`);
  server.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('오류', e); process.exit(1); });
