// Прогон всех игр ботами: node test/smoke.js (сервер должен быть запущен на :3000)
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const assert = (c, m) => {
  if (!c) throw new Error('ASSERT: ' + m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bot(name, real = '') {
  const s = io(URL, { transports: ['websocket'] });
  const b = { name, real, s, st: null, avatar: null, token: name + Math.random() };
  s.on('state', (st) => (b.st = st));
  b.call = (ev, data) => new Promise((r) => s.emit(ev, data, r));
  b.act = (type, x = {}) => b.call('action', { type, ...x });
  b.enter = (ev, code) => b.call(ev, { token: b.token, name: b.name, real: b.real, avatar: b.avatar, code });
  return b;
}

(async () => {
  const bots = [bot('Влад', 'Владислав'), bot('Костя'), bot('Руслан'), bot('Ян'), bot('Гость')];
  await wait(300);
  const [h] = bots;
  const r = await h.enter('createRoom');
  assert(r.ok, 'create');
  for (const b of bots.slice(1)) assert((await b.enter('joinRoom', r.code)).ok, 'join');
  await wait(200);
  assert(h.st.room.players.length === 5, 'players 5');
  assert(h.st.room.players[0].name === 'Влад' && h.st.room.players[0].real === 'Владислав', 'nick + real name');
  assert(h.st.room.players[1].real === '', 'real name optional');
  // без ника не пускаем
  const noname = bot('  ');
  await wait(200);
  assert((await noname.enter('joinRoom', r.code)).error, 'nickname required');
  noname.s.disconnect();
  // тот же ник (без учёта регистра), пока он онлайн — нельзя
  const dup = bot('костя');
  await wait(200);
  assert((await dup.enter('joinRoom', r.code)).error, 'duplicate nick rejected');
  dup.s.disconnect();
  // своё фото: загрузка → короткая ссылка → картинка по ссылке
  const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  assert((await h.call('uploadAvatar', { data: 'data:image/png;base64,AAAA' })).error, 'not an image rejected');
  assert((await h.call('uploadAvatar', { data: 'data:text/html;base64,PGI+' })).error, 'html rejected');
  const up = await h.call('uploadAvatar', { data: PNG1 });
  assert(up.ok && /^\/av\/[a-f0-9]{24}$/.test(up.url), 'upload → url');
  const img = await fetch(URL + up.url);
  assert(img.status === 200 && img.headers.get('content-type') === 'image/png', 'avatar served');
  assert((await h.call('setAvatar', { avatar: up.url })).ok, 'avatar set');
  assert((await h.call('setAvatar', { avatar: '/av/000000000000000000000000' })).error, 'unknown avatar rejected');
  assert((await h.call('setAvatar', { avatar: 'https://evil.example/x.png' })).error, 'foreign url rejected');
  await wait(100);
  assert(h.st.room.players[0].avatar === up.url, 'avatar stored');
  assert((await h.call('rename', { name: 'Костя' })).error, 'rename to taken nick rejected');
  assert((await h.call('rename', { name: 'Влад', real: 'Влад Д.' })).ok, 'rename real');
  await wait(60);
  assert(h.st.room.players[0].real === 'Влад Д.', 'real updated');
  console.log('✓ Профили');

  const g = (b) => b.st.game;
  const byId = (id) => bots.find((b) => b.st.me === id);

  // ---- Коднеймс: консенсус + отсчёт
  await h.call('selectGame', { type: 'codenames' });
  assert((await h.call('startGame', { settings: {} })).ok, 'cn start');
  await wait(100);
  await h.act('shuffleTeams');
  await wait(100);
  assert(g(h).step === 'setup' && !g(h).clock && g(h).cards[0].w === '', 'setup phase hides board');
  for (const b of bots) await b.act('ready');
  await wait(100);
  assert(g(h).step === 'clue' && g(h).clock, 'all ready → game starts');
  const mover = bots.find((b) => g(b).team[b.st.me] && g(b).captain[g(b).team[b.st.me]] !== b.st.me);
  const other = g(mover).team[mover.st.me] === 'red' ? 'blue' : 'red';
  assert((await mover.act('join', { team: other })).error, 'no team change mid-game');
  let cn = g(h);
  const cap = byId(cn.captain[cn.turn]);
  assert((await cap.act('clue', { word: 'юбка', slots: [1, 1.5] })).error, 'bad strength rejected');
  assert((await cap.act('clue', { word: 'юбка', slots: ['0.735'] })).error, '3 decimals rejected');
  assert((await cap.act('clue', { word: 'юбка', slots: ['0,73', 1, '1'] })).ok, 'clue');
  await wait(100);
  assert(JSON.stringify(g(h).clue.slots.map((x) => x.v)) === '[0.73,1,1]', 'slots parsed (order kept)');
  assert((await bots.find((b) => b !== cap).act('strike', { clue: 0, k: 0 })).error, 'only captain strikes');
  await cap.act('strike', { clue: 0, k: 2 });
  await wait(100);
  assert(g(h).clues[0].slots[2].done === true, 'struck');
  const agents = bots.filter((b) => g(b).team[b.st.me] === cn.turn && b !== cap);
  const own = g(cap).cards.findIndex((c) => c.color === cn.turn && !c.revealed);
  await agents[0].act('mark', { i: own });
  await wait(100);
  if (agents.length > 1) {
    assert(!g(h).pending, 'no pending until all agree');
    for (const a of agents.slice(1)) await a.act('mark', { i: own });
    await wait(100);
  }
  assert(g(h).pending && g(h).pending.i === own, 'pending countdown');
  await wait(3300);
  assert(g(agents[0]).cards[own].revealed, 'revealed after 3s');
  // отмена отсчёта
  const own2 = g(cap).cards.findIndex((c) => c.color === cn.turn && !c.revealed);
  for (const a of agents) await a.act('mark', { i: own2 });
  await wait(100);
  assert(g(h).pending, 'pending 2');
  await agents[0].act('mark', { i: own2 }); // снял голос
  await wait(100);
  assert(!g(h).pending, 'cancelled');
  await agents[0].act('endTurn');
  await wait(100);
  assert(g(h).turn !== cn.turn, 'turn passed');
  // таймер: после передачи хода у капитана 60 с, после подсказки — 60 с на отгадывание
  let ck = g(h).clock;
  assert(ck && ck.total === 60000 && !ck.paused, 'clue clock 60s');
  const cap2 = byId(g(h).captain[g(h).turn]);
  await cap2.act('clue', { word: 'проба' });
  await wait(100);
  assert(g(h).clock.total === 60000, 'guess clock');
  // правка подсказки в течение 15 с
  assert((await cap2.act('editClue', { word: 'исправил', slots: [1, '0.5'] })).ok, 'edit clue');
  await wait(100);
  assert(g(h).clue.word === 'исправил' && g(h).clue.slots.length === 2, 'clue edited');
  assert((await bots.find((b) => b !== cap2).act('editClue', { word: 'чужая' })).error, 'only author edits');
  // бонус +15 с за своё слово
  const before = g(h).clock.left;
  const ag2 = bots.filter((b) => g(b).team[b.st.me] === g(h).turn && b !== cap2);
  const own3 = g(cap2).cards.findIndex((c) => c.color === g(h).turn && !c.revealed);
  for (const a of ag2) await a.act('mark', { i: own3 });
  await wait(2300);
  assert(g(h).cards[own3].revealed, 'revealed after 2s');
  assert(g(h).clock.left > before + 10000, 'bonus +15s');
  // пауза таймера
  await h.act('pauseClock');
  await wait(100);
  assert(g(h).clock.paused, 'paused');
  const frozen = g(h).clock.left;
  await wait(400);
  assert(g(h).clock.left === frozen, 'frozen while paused');
  await h.act('pauseClock');
  await wait(100);
  assert(!g(h).clock.paused, 'resumed');
  // уход в лобби и возврат: игра сохраняется
  const turnBefore = g(h).turn;
  await h.call('stopGame');
  await wait(100);
  assert(!h.st.game && h.st.room.suspended?.type === 'codenames', 'suspended');
  assert((await h.call('resumeGame')).ok, 'resume');
  await wait(100);
  assert(h.st.game?.type === 'codenames' && g(h).turn === turnBefore && !g(h).clock.paused, 'resumed game state');
  console.log('✓ Коднеймс');
  await h.call('stopGame');

  // ---- Шпион: заявка шпиона + подтверждение + очки
  await h.call('selectGame', { type: 'spyfall' });
  assert((await h.call('startGame', { settings: { minutes: 5, spies: 1 } })).ok, 'spy start');
  await wait(100);
  let spy = bots.find((b) => g(b).isSpy);
  assert(!('locations' in g(spy)), 'no locations list');
  let town = bots.filter((b) => b !== spy);
  await town[0].act('vote', { target: spy.st.me }); // один голос — бонус
  await spy.act('claim');
  await wait(100);
  assert(g(h).phase === 'guessing', 'guessing');
  for (const t of town.slice(0, 3)) await t.act('judge', { ok: true });
  await wait(100);
  assert(g(h).phase === 'over' && g(h).result.kind === 'spyRight', 'spy right confirmed');
  assert(g(h).roundPts[spy.st.me].pts === 3, 'spy +3');
  assert(g(h).roundPts[town[0].st.me].pts === 1, 'correct voter +1');
  await h.act('next');
  await wait(100);
  // очередь вопросов
  const askerB = byId(g(h).asker);
  const others = bots.filter((b) => b !== askerB);
  assert((await others[0].act('answered')).error === undefined || !g(h).target, 'nobody to answer yet');
  if (others[0] !== h) assert((await others[0].act('askWho', { target: others[1].st.me })).error, 'only asker picks');
  await askerB.act('askWho', { target: others[0].st.me });
  await wait(50);
  assert(g(h).target === others[0].st.me, 'target set');
  await others[0].act('answered');
  await wait(50);
  assert(g(h).asker === others[0].st.me && g(h).asked[others[0].st.me] === 1 && g(h).prev === askerB.st.me, 'answerer asks next');
  assert((await others[0].act('askWho', { target: askerB.st.me })).error, 'no immediate ask-back');
  spy = bots.find((b) => g(b).isSpy);
  town = bots.filter((b) => b !== spy);
  for (const t of town) await t.act('vote', { target: spy.st.me });
  await wait(100);
  assert(g(h).result.kind === 'caught' && g(h).roundPts[town[0].st.me].pts === 2, 'caught: +1 +1');
  console.log('✓ Шпион (+ очередь вопросов)');
  await h.call('stopGame');

  // ---- Кто я: очки
  await h.call('selectGame', { type: 'whoami' });
  await h.call('startGame', { settings: { mode: 'random' } });
  await wait(100);
  // вопросы «да/нет» кнопками
  const wAsk = byId(g(h).turnPid);
  const wOthers = bots.filter((b) => b !== wAsk);
  await wAsk.act('ask', { text: 'Я человек?' });
  await wOthers[0].act('answer', { v: 'yes' });
  await wOthers[1].act('answer', { v: 'yes' });
  await wOthers[2].act('answer', { v: 'no' });
  assert((await wAsk.act('answer', { v: 'yes' })).error, 'asker cannot answer');
  await wait(50);
  assert(g(h).q.yes === 2 && g(h).q.no === 1 && g(h).q.text === 'Я человек?', 'tally');
  await wAsk.act('next');
  await wait(50);
  const hist = g(h).players[wAsk.st.me].qa;
  assert(hist.length === 1 && hist[0].v === 'yes', 'archived to history');
  const wAsk2 = byId(g(h).turnPid);
  const w2o = bots.filter((b) => b !== wAsk2);
  assert((await w2o[0].act('answer', { v: 'yes' })).error, 'no voice questions — need text');
  assert((await wAsk2.act('ask', { text: '' })).error, 'empty question rejected');
  assert(g(h).qEnds > Date.now() + 50000, 'question timer ~60s');
  await wAsk2.act('ask', { text: 'Я живой?' });
  for (const b of w2o) await b.act('answer', { v: 'yes' });
  await wait(60);
  assert(g(h).q && g(h).q.pend && g(h).q.pend.v === 'yes', '2s countdown before counting');
  await wait(2100);
  assert(g(h).turnPid === wAsk2.st.me && !g(h).q && g(h).players[wAsk2.st.me].qa.length === 1, 'all yes → same asker, next question');
  // ничья «да»/«нет» — ждём
  await wAsk2.act('ask', { text: 'Я из сериала?' });
  await w2o[0].act('answer', { v: 'yes' });
  await w2o[1].act('answer', { v: 'yes' });
  await w2o[2].act('answer', { v: 'no' });
  await w2o[3].act('answer', { v: 'no' });
  await wait(60);
  assert(g(h).turnPid === wAsk2.st.me && g(h).q && g(h).q.split, 'tie → wait for agreement');
  await w2o[3].act('answer', { v: 'yes' });
  await wait(2200);
  assert(!g(h).q && g(h).turnPid === wAsk2.st.me, 'tie resolved by change of vote');
  await wAsk2.act('ask', { text: 'Я из книги?' });
  for (const b of w2o) await b.act('answer', { v: 'no' });
  await wait(2200);
  assert(g(h).turnPid !== wAsk2.st.me, 'all no → turn passes');
  for (const b of bots) await b.act('guessed');
  await wait(100);
  const pts = g(h).points;
  const order = g(h).finishOrder;
  assert(g(h).phase === 'over' && pts[order[0]] === 3 && pts[order[1]] === 2 && pts[order[2]] === 1, 'whoami points');
  console.log('✓ Кто я (+ ответы кнопками)');
  await h.call('stopGame');

  // ---- Намёк понял: сердечко и очки
  await h.call('selectGame', { type: 'justone' });
  await h.call('startGame', { settings: { target: 3 } });
  await wait(100);
  const guesser = byId(g(h).guesser);
  const helpers = bots.filter((b) => b !== guesser);
  const word = g(helpers[0]).word;
  const cl = ['одинаково', 'одинаково', 'ракета', 'облако'];
  assert((await helpers[0].act('clue', { text: 'два слова' })).error, 'only one word');
  assert((await helpers[0].act('clue', { text: 'слово!' })).error, 'no symbols');
  assert(g(h).endsAt && g(h).phaseMs === 60000, 'clues timer 60s');
  for (const [i, b] of helpers.entries()) await b.act('clue', { text: cl[i] });
  assert((await helpers[0].act('clue', { text: 'другое' })).error, 'no replacing');
  await wait(100);
  assert(g(h).phase === 'filter' && g(h).phaseMs === 30000, 'filter timer 30s');
  {
    const cs = g(helpers[1]).clues;
    const a = cs.find((c) => c.pid === helpers[0].st.me), b = cs.find((c) => c.pid === helpers[1].st.me);
    assert(a.first && !a.removed && b.removed && b.beat === helpers[0].st.me, 'first writer keeps duplicate clue');
  }
  await helpers[0].act('filterDone');
  await wait(50);
  assert(g(h).phase === 'filter' && g(h).show.length === 1, 'show needs everyone');
  for (const b of helpers.slice(1)) await b.act('filterDone');
  await wait(50);
  assert(g(h).phase === 'guess', 'all pressed show');
  await guesser.act('guess', { text: word });
  await wait(100);
  assert(g(h).correct, 'correct');
  assert((await helpers.find((b) => b !== h).act('next')).error, 'helpers wait for heart');
  await guesser.act('heart', { pid: helpers[2].st.me });
  await guesser.act('next');
  await wait(100);
  const P = g(h).points;
  assert(P[guesser.st.me] === 2 && P[helpers[2].st.me] === 4 && P[helpers[3].st.me] === 1 && P[helpers[0].st.me] === 1 && P[helpers[1].st.me] === 0, 'justone points (first writer keeps dup) ' + JSON.stringify(P));
  assert(g(h).phase === 'over' && g(h).winners[0] === helpers[2].st.me, 'target reached');
  assert(g(h).hearts[helpers[2].st.me] === 1, 'hearts counted');
  // неточный ответ засчитывается, только когда «за» все подсказчики
  await h.act('restart');
  await wait(100);
  const g2 = byId(g(h).guesser);
  const hs2 = bots.filter((b) => b !== g2);
  for (const [i, b] of hs2.entries()) await b.act('clue', { text: 'подсказка' + i });
  await wait(100);
  for (const b of hs2) await b.act('filterDone');
  await wait(50);
  await g2.act('guess', { text: 'почтитак' });
  await wait(100);
  assert(g(h).correct === false, 'near-miss not correct');
  if (g2 !== h) assert((await g2.act('next')).error, 'guesser cannot skip the vote');
  for (const b of hs2.slice(0, -1)) await b.act('accept');
  await wait(100);
  assert(g(h).correct === false && g(h).accept.length === hs2.length - 1, 'not all agreed yet');
  await hs2[0].act('accept'); // передумал
  await hs2[0].act('accept');
  await hs2[hs2.length - 1].act('accept');
  await wait(100);
  assert(g(h).correct === true && g(h).accepted, 'accepted by all helpers');
  assert((await hs2[1].act('accept')).error, 'locked after accept');
  // «не засчитывать» — тоже только всеми
  await g2.act('next');
  await wait(80);
  const g3 = byId(g(h).guesser);
  const hs3 = bots.filter((b) => b !== g3);
  for (const [i, b] of hs3.entries()) await b.act('clue', { text: 'намёк' + i });
  for (const b of hs3) await b.act('filterDone');
  await g3.act('guess', { text: 'мимо' });
  await wait(50);
  const r0 = g(h).round;
  for (const b of hs3.slice(1)) await b.act('reject');
  await wait(50);
  assert(g(h).phase === 'result' && g(h).round === r0, 'reject needs everyone');
  await hs3[0].act('reject');
  await wait(80);
  assert(g(h).round === r0 + 1 && g(h).phase === 'clues', 'all rejected → next round');
  {
    const rr = g(h).round;
    await h.act('skipRound');
    await wait(50);
    assert(g(h).round === rr + 1 && g(h).phase === 'clues', 'host skips round');
  }
  console.log('✓ Намёк понял (таймеры, одно слово, решения всеми)');
  await h.call('stopGame');

  // ---- Викторина: ближайший ответ получает балл, точное попадание — бонус
  await h.call('selectGame', { type: 'quiz' });
  assert((await h.call('startGame', { settings: { rounds: 3, seconds: 30 } })).ok, 'quiz start');
  await wait(80);
  assert(g(h).phase === 'answer' && g(h).q.text && g(h).q.answer === null, 'answer hidden while answering');
  {
    const e0 = g(h).endsAt;
    assert((await bots[1].act('addTime')).error, 'only host adds time');
    await h.act('addTime');
    await wait(50);
    assert(g(h).endsAt >= e0 + 14000, 'host +15s');
    const q0 = g(h).q.text;
    await h.act('newQuestion');
    await wait(50);
    assert(g(h).round === 1 && g(h).q.text !== q0, 'host replaces question');
  }
  // правильный ответ узнаём через хост-«показать» в следующем раунде нельзя — считаем по результату
  assert((await bots[0].act('answer', { v: 'abc' })).error, 'only numbers');
  await bots[0].act('answer', { v: '1' });
  await bots[1].act('answer', { v: '-5' });
  await bots[2].act('answer', { v: '3,5' });
  await bots[3].act('answer', { v: '100000' });
  await wait(60);
  assert(g(h).phase === 'answer' && g(h).answered.length === 4, 'waits for everyone');
  await bots[4].act('answer', { v: '42' });
  await wait(80);
  const R = g(h).res;
  assert(g(h).phase === 'reveal' && R && typeof R.answer === 'number', 'reveal after all answered');
  const best = Math.min(...R.list.map((x) => x.diff));
  assert(R.winners.every((id) => R.list.find((x) => x.pid === id).diff === best), 'closest wins');
  assert(R.winners.every((id) => g(h).points[id] >= 1), 'winners got points');
  assert(g(h).q.mask && /^−?X+(,X+)?$/.test(g(h).q.mask), 'answer mask XXX');
  for (const b of bots) await b.act('ready');
  await wait(80);
  assert(g(h).phase === 'reveal' && g(h).nextAt > Date.now() + 3000, 'all ready → 5s countdown');
  assert((await bots[0].act('ready')) && g(h).ready.length === 5, 'ready locked during countdown');
  await h.act('skip');
  await wait(60);
  assert(g(h).round === 2 && g(h).phase === 'answer', 'next question after countdown');
  await h.act('skip');
  await wait(50);
  assert(g(h).phase === 'reveal' && g(h).res.list.length === 0, 'host can reveal early');
  for (let k = 0; k < 5; k++) await h.act('skip');
  await wait(50);
  assert(g(h).phase === 'over', 'game over after rounds');
  console.log('✓ Викторина');
  await h.call('stopGame');

  // ---- Ответ большинства: совпадения приносят очки, хост склеивает похожие
  await h.call('selectGame', { type: 'majority' });
  assert((await h.call('startGame', { settings: { rounds: 3, seconds: 30 } })).ok, 'majority start');
  await wait(60);
  {
    const ps = bots.filter((b) => g(b).order.includes(b.st.me));
    assert(ps.length >= 4, 'majority players');
    assert(g(h).phase === 'answer' && typeof g(h).q === 'string', 'majority question');
    assert((await ps[0].act('answer', { text: '   ' })).error, 'empty answer rejected');
    // «Свечи» / «свечку» / «СВЕЧИ!» — одна группа; «фонарик» и «павербанк» — отдельно
    const texts = ['Свечи', 'свечку', 'СВЕЧИ!', 'фонарик', 'павербанк'];
    for (let i = 0; i < ps.length - 1; i++) await ps[i].act('answer', { text: texts[i] });
    await wait(60);
    assert(g(h).phase === 'answer' && g(h).answered.length === ps.length - 1, 'waits for everyone');
    assert(!JSON.stringify(g(ps[1])).includes('Свечи'), 'answers are secret');
    await ps[ps.length - 1].act('answer', { text: texts[ps.length - 1] });
    await wait(60);
    assert(g(h).phase === 'review', 'all answered → review');
    const big = g(h).groups[0];
    assert(big.pids.length === 3 && big.major, 'similar answers grouped, majority marked');
    assert(g(h).preview[ps[0].st.me] === 3, '2 matches + majority bonus = 3');
    // хост склеивает «фонарик» с «павербанком»
    const solo = g(h).groups.filter((x) => x.pids.length === 1);
    assert((await ps[1].act('merge', { a: solo[0].pids[0], b: solo[1].pids[0] })).error || ps[1] === h, 'only host merges');
    await h.act('merge', { a: solo[0].pids[0], b: solo[1].pids[0] });
    await wait(40);
    assert(g(h).groups.length === 2 && g(h).groups[1].pids.length === 2, 'host merged groups');
    await h.act('split', { a: solo[0].pids[0] });
    await wait(40);
    assert(g(h).groups.length === 3, 'host split answer back');
    for (const b of ps) await b.act('ready');
    await wait(60);
    assert(g(h).phase === 'review' && g(h).nextAt, 'majority countdown');
    await h.act('skip');
    await wait(60);
    assert(g(h).round === 2 && g(h).phase === 'answer' && g(h).points[ps[0].st.me] === 3, 'points applied, next question');
    await h.act('skip');
    await wait(40);
    assert(g(h).phase === 'review', 'host opens answers');
    for (let k = 0; k < 5; k++) await h.act('skip');
    await wait(60);
    assert(g(h).phase === 'over', 'majority over');
  }
  console.log('✓ Ответ большинства');
  await h.call('stopGame');

  // ---- Марафон
  const plan = [
    { type: 'codenames', rounds: 1 },
    { type: 'whoami', rounds: 1, settings: { mode: 'random' } },
    { type: 'spyfall', rounds: 1 },
  ];
  assert((await h.call('startTour', { plan })).ok, 'tour start');
  await wait(100);
  let t = h.st.room.tour;
  assert(t.queue.length === 3 && h.st.game.type === 'codenames', 'tour queue');
  assert((await h.act('newBoard')).error, 'no restart in tour');
  // проигрываем коднеймс открытием убийцы
  await h.act('shuffleTeams');
  await wait(100);
  await h.act('forceStart');
  await wait(100);
  cn = g(h);
  await byId(cn.captain[cn.turn]).act('clue', { word: 'тест' });
  await wait(100);
  const ass = g(byId(cn.captain[cn.turn])).cards.findIndex((c) => c.color === 'assassin');
  const ag = bots.filter((b) => g(b).team[b.st.me] === cn.turn && b.st.me !== cn.captain[cn.turn]);
  for (const a of ag) await a.act('mark', { i: ass });
  await wait(3300);
  t = h.st.room.tour;
  assert(t.phase === 'between', 'between after codenames');
  const sm = g(h).summary;
  assert(sm && sm.assassin.length === ag.length && sm.miss && sm.turns >= 1 && sm.duration > 0 && sm.slowCap && sm.lead === null, 'codenames summary ' + JSON.stringify(sm));
  const winners = Object.keys(g(h).team).filter((id) => g(h).team[id] === g(h).winner);
  assert(winners.every((id) => t.totals[id] === 3), 'winners +3');
  assert((await bots[1].call('tourNext')).error, 'only host next');
  await h.call('tourNext');
  await wait(100);
  assert(h.st.game.type === 'whoami', 'second game');
  for (const b of bots) await b.act('guessed');
  await wait(100);
  await h.call('tourNext');
  await wait(100);
  spy = bots.find((b) => g(b).isSpy);
  for (const b of bots.filter((x) => x !== spy)) await b.act('vote', { target: spy.st.me });
  await wait(100);
  t = h.st.room.tour;
  assert(t.phase === 'done', 'done');
  await h.call('tourNext');
  await wait(100);
  assert(h.st.room.tour.phase === 'final' && !h.st.game, 'final');
  const noms = h.st.room.tour.nominations.map((n) => n.key);
  assert(noms.includes('sherlock') && noms.includes('detector'), 'nominations ' + noms.join(','));
  const sum = Object.values(h.st.room.tour.totals).reduce((a, b) => a + b, 0);
  assert(sum > 0, 'totals');
  await h.call('tourEnd');
  await wait(100);
  assert(!h.st.room.tour, 'tour closed');
  console.log('✓ Марафон');

  // ---- Радио комнаты: общее, с очередью
  {
    const guest = bots[1];
    let r = h.st.room.radio;
    assert(r.cur.live && r.cur.vid === 'rFZHOHl-L8A', 'default lofi');
    assert((await guest.call('radio', { op: 'add', url: 'не ссылка' })).error, 'bad url');
    assert((await guest.call('radio', { op: 'add', url: 'https://youtu.be/dQw4w9WgXcQ' })).ok, 'add 1');
    await wait(80);
    r = h.st.room.radio;
    assert(r.cur.vid === 'dQw4w9WgXcQ' && !r.queue.length && r.cur.by === guest.st.me, 'first track replaces lofi for everyone');
    assert(bots[2].st.room.radio.cur.vid === 'dQw4w9WgXcQ', 'same for others');
    await guest.call('radio', { op: 'add', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
    await bots[2].call('radio', { op: 'add', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' });
    await wait(80);
    r = h.st.room.radio;
    assert(r.cur.vid === 'dQw4w9WgXcQ' && r.queue.length === 2, 'queued, current not interrupted');
    assert((await guest.call('radio', { op: 'add', url: 'https://youtu.be/aaaaaaaaaaa' })).error, 'no duplicates');
    assert((await guest.call('radio', { op: 'remove', qid: r.queue[1].qid })).error, "can't remove someone else's track");
    // свой трек убрать можно
    await guest.call('radio', { op: 'add', url: 'https://youtu.be/ddddddddddd' });
    await wait(60);
    const own = h.st.room.radio.queue.find((x) => x.vid === 'ddddddddddd');
    assert(own && (await guest.call('radio', { op: 'remove', qid: own.qid })).ok, 'remove own track');
    await wait(60);
    assert(h.st.room.radio.queue.length === 2, 'own track removed');
    assert((await guest.call('radio', { op: 'now', url: 'https://youtu.be/ccccccccccc' })).error, 'only host plays now');
    await h.call('radio', { op: 'move', qid: r.queue[1].qid, d: -1 });
    await wait(80);
    assert(h.st.room.radio.queue[0].vid === 'bbbbbbbbbbb', 'host reorders');
    await h.call('radio', { op: 'moveTo', qid: h.st.room.radio.queue[0].qid, to: 1 });
    await wait(60);
    assert(h.st.room.radio.queue[1].vid === 'bbbbbbbbbbb', 'drag moveTo');
    await h.call('radio', { op: 'moveTo', qid: h.st.room.radio.queue[1].qid, to: 0 });
    await guest.call('radio', { op: 'ended', id: 'wrong' });
    await guest.call('radio', { op: 'ended', id: h.st.room.radio.cur.id }); // слишком рано (<5 c) — игнор
    await wait(80);
    assert(h.st.room.radio.cur.vid === 'dQw4w9WgXcQ', 'early/stale ended ignored');
    await h.call('radio', { op: 'skip' });
    await wait(80);
    assert(h.st.room.radio.cur.vid === 'bbbbbbbbbbb' && h.st.room.radio.queue.length === 1, 'skip → next in queue');
    await h.call('radio', { op: 'remove', qid: h.st.room.radio.queue[0].qid });
    await h.call('radio', { op: 'skip' });
    await wait(80);
    assert(h.st.room.radio.cur.live, 'empty queue → back to lofi');
    console.log('✓ Радио комнаты');
  }

  // ---- реконнект по нику с другого устройства и кик
  const yan = bots[3];
  yan.s.disconnect();
  await wait(200);
  assert(!h.st.room.players.find((p) => p.name === 'Ян').connected, 'offline');
  const again = bot('Ян'); // новое устройство, другой токен
  await wait(300);
  assert((await again.enter('joinRoom', r.code)).ok, 'rejoin by nick');
  await wait(100);
  assert(h.st.room.players.length === 5 && h.st.room.players.find((p) => p.name === 'Ян').connected, 'same seat');
  await h.call('kick', { target: again.st.me });
  await wait(100);
  assert(h.st.room.players.length === 4, 'kicked');
  console.log('✓ Переподключение и кик');

  // ---- Мало игроков: игра открывается в ожидании, ошибка — только при старте
  {
    const solo = bot('Соло');
    await wait(200);
    const rr = await solo.enter('createRoom');
    assert(rr.ok, 'solo room');
    await solo.call('selectGame', { type: 'quiz' });
    assert((await solo.call('startGame', { settings: { rounds: 3 } })).ok, 'quiz opens with 1 player');
    await wait(60);
    assert(solo.st.game && solo.st.game.waiting && /минимум 2/.test(solo.st.game.need), 'waiting view');
    const e1 = await solo.act('begin');
    assert(e1.error && /минимум 2/.test(e1.error), 'begin errors while too few');
    const friend = bot('Друг');
    await wait(200);
    assert((await friend.enter('joinRoom', rr.code)).ok, 'friend joins by link');
    await wait(60);
    assert(friend.st.game && friend.st.game.waiting, 'friend lands in waiting game');
    assert((await friend.act('begin')).error, 'only host begins');
    assert((await solo.act('begin')).ok, 'host begins');
    await wait(60);
    assert(friend.st.game.phase === 'answer' && friend.st.game.order.length === 2, 'game started for both');
    solo.s.disconnect();
    friend.s.disconnect();
    console.log('✓ Ожидание игроков');
  }

  console.log('\nВСЕ ТЕСТЫ ПРОШЛИ');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
