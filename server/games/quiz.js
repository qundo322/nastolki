const QUESTIONS = require('../quiz_questions');
const { shuffle, Deck, clampInt, countLabel } = require('../util');

// «Викторина»: ответ — число, балл получает тот, кто ближе всех к правильному
const REVEAL_MS = 10000; // 10 секунд на результат; нажали «Дальше» все — сразу следующий вопрос

const META = {
  title: 'Викторина',
  emoji: '🔢',
  players: '2–20',
  content: countLabel(QUESTIONS.length, 'вопрос', 'вопроса', 'вопросов'),
  short: 'Ответ — всегда число. Кто ближе всех к правде — получает балл. Точное попадание — бонус.',
  rules: [
    'Каждый раунд — вопрос, ответ на который число: год, высота, количество.',
    'Все пишут свой ответ, пока идёт таймер. Ответ можно менять, пока время не вышло.',
    'Кто ближе всех к правильному ответу — получает +1. Точное попадание — ещё +1. Если ближе всех несколько — балл получает каждый.',
    'После каждого раунда шкала эффектно заполняется до правильного ответа, а на ней видно, кто где промахнулся.',
    'Побеждает тот, у кого больше всего очков после последнего раунда.',
  ],
  restartActions: ['restart'],
  settings: [
    { key: 'rounds', label: 'Вопросов', type: 'select', options: [10, 15, 20, 30], default: 15 },
    { key: 'seconds', label: 'Секунд на ответ', type: 'select', options: [20, 30, 45, 60], default: 30 },
  ],
};

const parseNum = (v) => {
  const t = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.').replace('−', '-');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : null;
};

// Подсказка «сколько знаков»: 1492 → XXXX, 3.14 → X,XX, −40 → −XX
function mask(a) {
  const t = String(Math.abs(a));
  const [i, f] = t.split('.');
  return (a < 0 ? '−' : '') + 'X'.repeat(i.length) + (f ? ',' + 'X'.repeat(f.length) : '');
}

// Стандартная колода: числовые вопросы из quiz_questions
function defaultDraw(s) {
  if (!s.deck) s.deck = new Deck(shuffle(QUESTIONS.map((q, i) => i)));
  const [cat, text, answer, unit] = QUESTIONS[s.deck.draw()];
  return { kind: 'num', cat, text, answer, unit };
}

// Фабрика викторин: вопросы бывают числовые (ближе всех +1, точно +1)
// и с вариантами А–Г (верно +1, самый быстрый верный ещё +1). Картинка — по желанию.
function build({ meta = META, draw = defaultDraw, name = 'Викторины', timerKey = 'quiz' } = {}) {
function create(ctx, st) {
  const ids = ctx.players().map((p) => p.id);
  if (ids.length < 2) return `Для «${name}» нужно минимум 2 игрока`;
  const s = {
    rounds: clampInt(st.rounds, 3, 50, 15),
    seconds: clampInt(st.seconds, 10, 120, 30),
    order: ids,
    points: Object.fromEntries(ids.map((id) => [id, 0])),
    wins: {}, // сколько раз был ближе всех — для номинаций
    exacts: {},
    round: 0,
    history: [],
  };
  startRound(s, ctx);
  return s;
}

function setTimer(s, ctx, ms, fn) {
  ctx.clearTimer(timerKey);
  s.endsAt = Date.now() + ms;
  s.phaseMs = ms;
  ctx.setTimer(timerKey, ms, fn);
}

function startRound(s, ctx) {
  s.round++;
  s.q = draw(s);
  s.answers = {};
  s.answeredAt = {};
  s.res = null;
  s.phase = 'answer';
  setTimer(s, ctx, s.seconds * 1000, () => reveal(s, ctx));
}

function reveal(s, ctx) {
  if (s.phase !== 'answer') return;
  if (s.q.kind === 'choice') return revealChoice(s, ctx);
  const a = s.q.answer;
  const list = Object.entries(s.answers).map(([pid, v]) => ({ pid, v, diff: Math.abs(v - a) }));
  const best = list.length ? Math.min(...list.map((x) => x.diff)) : null;
  const winners = best == null ? [] : list.filter((x) => x.diff === best).map((x) => x.pid);
  const exact = list.filter((x) => x.diff < 1e-9).map((x) => x.pid);
  const got = {};
  for (const id of winners) {
    got[id] = (got[id] || 0) + 1;
    s.wins[id] = (s.wins[id] || 0) + 1;
  }
  for (const id of exact) {
    got[id] = (got[id] || 0) + 1;
    s.exacts[id] = (s.exacts[id] || 0) + 1;
  }
  for (const [id, n] of Object.entries(got)) s.points[id] = (s.points[id] || 0) + n;
  s.res = { answer: a, list: list.sort((x, y) => x.diff - y.diff), winners, exact, got };
  s.history.push({ q: s.q.text, answer: a, unit: s.q.unit, winners });
  s.phase = 'reveal';
  s.ready = {};
  setTimer(s, ctx, REVEAL_MS, () => advance(s, ctx));
}

// Вопрос с вариантами: верный ответ +1, самый быстрый из верных — ещё +1
function revealChoice(s, ctx) {
  const ok = s.q.correct;
  const list = Object.entries(s.answers).map(([pid, v]) => ({ pid, v, ok: v === ok, at: s.answeredAt[pid] || 0 }));
  const right = list.filter((x) => x.ok).sort((a, b) => a.at - b.at);
  const first = right.length && s.order.length > 1 ? right[0].pid : null;
  const got = {};
  for (const x of right) got[x.pid] = 1;
  if (first) {
    got[first] = 2;
    s.wins[first] = (s.wins[first] || 0) + 1;
  }
  for (const [id, n] of Object.entries(got)) s.points[id] = (s.points[id] || 0) + n;
  s.res = { correct: ok, list: list.sort((a, b) => (b.ok - a.ok) || a.at - b.at), winners: right.map((x) => x.pid), first, got, picks: Object.fromEntries(s.q.opts.map((_, i) => [i, list.filter((x) => x.v === i).map((x) => x.pid)])) };
  s.history.push({ q: s.q.text, answer: s.q.opts[ok], winners: right.map((x) => x.pid) });
  s.phase = 'reveal';
  s.ready = {};
  setTimer(s, ctx, REVEAL_MS, () => advance(s, ctx));
}


function advance(s, ctx) {
  if (s.phase !== 'reveal') return;
  if (s.round >= s.rounds) {
    s.phase = 'over';
    ctx.clearTimer(timerKey);
    s.endsAt = null;
    const top = Math.max(...Object.values(s.points));
    s.winners = Object.keys(s.points).filter((id) => s.points[id] === top);
    return;
  }
  startRound(s, ctx);
}

const online = (s, ctx) => s.order.filter((id) => ctx.room.players.get(id) && ctx.room.players.get(id).connected !== false);

function action(s, pid, msg, ctx) {
  switch (msg.type) {
    case 'answer': {
      if (s.phase !== 'answer') return 'Время ответа вышло';
      if (!s.order.includes(pid)) return 'Вы не в игре';
      if (s.q.kind === 'choice') {
        // выбор окончательный — так честно считается «самый быстрый»
        if (s.answers[pid] != null) return 'Ответ уже принят';
        const i = Number(msg.v);
        if (!Number.isInteger(i) || i < 0 || i >= s.q.opts.length) return 'Выберите вариант';
        s.answers[pid] = i;
        s.answeredAt[pid] = Date.now();
        if (online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
        return;
      }
      const v = parseNum(msg.v);
      if (v == null) return 'Нужно число: например 1492 или 3,14';
      s.answers[pid] = v;
      // ответили все — сразу показываем результат
      if (online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
      return;
    }
    case 'ready': {
      // «Дальше»: когда готовы все — следующий вопрос раньше таймера
      if (s.phase !== 'reveal') return;
      s.ready[pid] = !s.ready[pid];
      if (online(s, ctx).every((id) => s.ready[id])) advance(s, ctx);
      return;
    }
    case 'skip': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase === 'answer') reveal(s, ctx);
      else if (s.phase === 'reveal') advance(s, ctx);
      return;
    }
    case 'addTime': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'answer') return;
      const left = s.endsAt - Date.now() + 15000;
      setTimer(s, ctx, left, () => reveal(s, ctx));
      s.phaseMs = Math.max(left, s.seconds * 1000);
      return;
    }
    case 'newQuestion': {
      // Заменить текущий вопрос другим (номер раунда тот же)
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'answer') return;
      s.round--;
      startRound(s, ctx);
      return;
    }
    case 'restart': {
      if (!ctx.isHost) return 'Только хост';
      for (const id of Object.keys(s.points)) s.points[id] = 0;
      s.wins = {};
      s.exacts = {};
      s.history = [];
      s.round = 0;
      s.winners = null;
      startRound(s, ctx);
      return;
    }
    case 'addMe': {
      if (s.order.includes(pid)) return;
      s.order.push(pid);
      s.points[pid] = 0;
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid) {
  const showAll = s.phase !== 'answer';
  return {
    phase: s.phase,
    round: s.round,
    rounds: s.rounds,
    endsAt: s.endsAt,
    phaseMs: s.phaseMs,
    q: s.q
      ? s.q.kind === 'choice'
        ? { kind: 'choice', cat: s.q.cat, text: s.q.text, opts: s.q.opts, img: s.q.img, correct: showAll ? s.q.correct : null }
        : { kind: 'num', cat: s.q.cat, text: s.q.text, unit: s.q.unit, img: s.q.img, answer: showAll ? s.q.answer : null, mask: mask(s.q.answer) }
      : null,
    answered: Object.keys(s.answers || {}),
    mine: s.answers?.[pid] ?? null,
    res: showAll ? s.res : null,
    ready: Object.keys(s.ready || {}).filter((id) => s.ready[id]),
    inGame: s.order.includes(pid),
    order: s.order,
    points: s.points,
    wins: s.wins,
    winners: s.winners || null,
    history: s.history.slice(-10),
  };
}

function onLeave(s, pid, ctx) {
  s.order = s.order.filter((x) => x !== pid);
  delete s.points[pid];
  delete s.answers[pid];
  delete s.wins[pid];
  if (s.ready) delete s.ready[pid];
  if (s.phase === 'answer' && s.order.length && online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
}
const onPresence = (s, ctx) => {
  if (s.phase === 'answer' && online(s, ctx).length && online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
};
function pause(s, ctx) {
  if (!s.endsAt) return;
  s._left = Math.max(0, s.endsAt - Date.now());
  ctx.clearTimer(timerKey);
}
function resume(s, ctx) {
  if (s._left == null) return;
  const left = s._left;
  s._left = null;
  if (s.phase === 'answer') setTimer(s, ctx, left, () => reveal(s, ctx));
  else if (s.phase === 'reveal') {
    setTimer(s, ctx, left, () => advance(s, ctx));
  }
}

const isOver = (s) => s.phase === 'over';
const results = (s) => ({ ...s.points });
const stats = (s) => ({ quiz: { ...s.wins } });

return { meta, create, action, view, onLeave, onPresence, isOver, results, stats, pause, resume, parseNum, mask };
}

module.exports = { ...build(), build };
