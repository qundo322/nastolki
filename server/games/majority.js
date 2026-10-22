const QUESTIONS = require('../majority_questions');
const { shuffle, Deck, clampInt, countLabel } = require('../util');

// «Ответ большинства»: все тайно отвечают на простой вопрос. Совпал с другими — получил очки.
const REVIEW_MS = 30000; // время на разбор ответов (хост может склеить похожие)

const meta = {
  title: 'Ответ большинства',
  emoji: '👥',
  players: '3–20',
  content: countLabel(QUESTIONS.length, 'вопрос', 'вопроса', 'вопросов'),
  short: 'Простой вопрос — тайный ответ. Совпал с другими — получил очки. Думай, как все!',
  rules: [
    'Появляется простой вопрос: «Что первым покупают перед отключением света?». Правильного ответа нет.',
    'Каждый тайно пишет ответ — одно-два слова. Пока идёт время, ответ можно поменять.',
    'Потом ответы открываются и сами собираются в группы. Похожие («свечи» и «свечку») хост может склеить.',
    'За каждого, кто ответил так же, как ты, — +1. Самая большая группа получает ещё +1 каждому.',
  ],
  restartActions: ['restart'],
  settings: [
    { key: 'rounds', label: 'Вопросов', type: 'select', options: [8, 10, 15, 20], default: 10 },
    { key: 'seconds', label: 'Секунд на ответ', type: 'select', options: [30, 45, 60], default: 45 },
  ],
};

// ---- сравнение ответов ----
const ENDINGS = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|ией|ах|ях|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ые|ие|ам|ям|ом|ем|ую|юю|ку|ки|ка|а|я|ы|и|у|ю|о|е|ь|й)$/;
const STOP = new Set(['в', 'на', 'и', 'с', 'со', 'по', 'к', 'из', 'за', 'для', 'от', 'до', 'у', 'о', 'это', 'конечно', 'наверное']);
function normWords(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`’.,!?;:()\-–—]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}
const stem = (w) => (w.length > 4 ? w.replace(ENDINGS, '') : w);
const key = (t) => normWords(t).map(stem).sort().join(' ');
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Похожи ли два ключа: совпадают или отличаются одной буквой (опечатка / другая форма)
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n >= 4 && lev(a, b) <= 1) return true;
  if (n >= 7 && lev(a, b) <= 2) return true;
  return false;
}

// Собираем группы: pid → номер группы
function autoGroups(answers) {
  const ids = Object.keys(answers);
  const parent = Object.fromEntries(ids.map((id) => [id, id]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const keys = Object.fromEntries(ids.map((id) => [id, key(answers[id])]));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) if (similar(keys[ids[i]], keys[ids[j]])) parent[find(ids[i])] = find(ids[j]);
  const g = {};
  for (const id of ids) g[id] = find(id);
  return g;
}

// Очки по текущим группам
function score(groupOf) {
  const sizes = {};
  for (const gid of Object.values(groupOf)) sizes[gid] = (sizes[gid] || 0) + 1;
  const max = Math.max(0, ...Object.values(sizes));
  const tops = Object.keys(sizes).filter((g) => sizes[g] === max);
  const majority = max >= 2 && tops.length === 1 ? tops[0] : null;
  const got = {};
  for (const [pid, gid] of Object.entries(groupOf)) {
    const p = sizes[gid] - 1 + (gid === majority ? 1 : 0);
    if (p > 0) got[pid] = p;
  }
  return { got, majority, sizes };
}

function create(ctx, st) {
  const ids = ctx.players().map((p) => p.id);
  if (ids.length < 3) return 'Для «Ответа большинства» нужно минимум 3 игрока';
  const s = {
    rounds: clampInt(st.rounds, 3, 40, 10),
    seconds: clampInt(st.seconds, 10, 180, 45),
    order: ids,
    points: Object.fromEntries(ids.map((id) => [id, 0])),
    herd: {}, // сколько раз был в группе большинства — для номинации
    deck: new Deck(shuffle(QUESTIONS.map((_, i) => i))),
    round: 0,
  };
  startRound(s, ctx);
  return s;
}

function setTimer(s, ctx, ms, fn) {
  ctx.clearTimer('maj');
  s.endsAt = Date.now() + ms;
  s.phaseMs = ms;
  ctx.setTimer('maj', ms, fn);
}

function startRound(s, ctx) {
  s.round++;
  s.q = QUESTIONS[s.deck.draw()];
  s.answers = {};
  s.groupOf = {};
  s.ready = {};
  s.last = null;
  s.phase = 'answer';
  setTimer(s, ctx, s.seconds * 1000, () => reveal(s, ctx));
}

function reveal(s, ctx) {
  if (s.phase !== 'answer') return;
  s.groupOf = autoGroups(s.answers);
  s.phase = 'review';
  s.ready = {};
  setTimer(s, ctx, REVIEW_MS, () => advance(s, ctx));
}

// Конец разбора: начисляем очки по группам (с учётом склеек хоста)
function finishRound(s) {
  const { got, majority } = score(s.groupOf);
  for (const [id, n] of Object.entries(got)) s.points[id] = (s.points[id] || 0) + n;
  if (majority) for (const [pid, gid] of Object.entries(s.groupOf)) if (gid === majority) s.herd[pid] = (s.herd[pid] || 0) + 1;
  s.last = { q: s.q, got };
}

function advance(s, ctx) {
  if (s.phase !== 'review') return;
  finishRound(s);
  if (s.round >= s.rounds) {
    s.phase = 'over';
    ctx.clearTimer('maj');
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
      const t = String(msg.text || '').trim().replace(/\s+/g, ' ');
      if (!t) return 'Напишите ответ';
      if (t.length > 40) return 'Коротко: одно-два слова';
      if (!normWords(t).length) return 'Напишите ответ словами';
      s.answers[pid] = t;
      if (online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
      return;
    }
    case 'merge': {
      // Хост склеивает две группы похожих ответов: a — группа (pid любого её участника), b — куда
      if (!ctx.isHost) return 'Склеивает хост';
      if (s.phase !== 'review') return;
      const ga = s.groupOf[msg.a];
      const gb = s.groupOf[msg.b];
      if (!ga || !gb || ga === gb) return;
      for (const id of Object.keys(s.groupOf)) if (s.groupOf[id] === ga) s.groupOf[id] = gb;
      return;
    }
    case 'split': {
      // Отделить ответ от группы (если склеилось лишнее)
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'review' || !s.groupOf[msg.a]) return;
      s.groupOf[msg.a] = msg.a + '#' + Date.now();
      return;
    }
    case 'ready': {
      if (s.phase !== 'review') return;
      s.ready[pid] = !s.ready[pid];
      if (online(s, ctx).every((id) => s.ready[id])) advance(s, ctx);
      return;
    }
    case 'skip': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase === 'answer') reveal(s, ctx);
      else if (s.phase === 'review') advance(s, ctx);
      return;
    }
    case 'addTime': {
      if (!ctx.isHost) return 'Только хост';
      if (!s.endsAt || s.phase === 'over') return;
      const left = s.endsAt - Date.now() + 15000;
      const fn = s.phase === 'answer' ? () => reveal(s, ctx) : () => advance(s, ctx);
      setTimer(s, ctx, left, fn);
      s.phaseMs = Math.max(left, s.phase === 'answer' ? s.seconds * 1000 : REVIEW_MS);
      return;
    }
    case 'newQuestion': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'answer') return;
      s.round--;
      startRound(s, ctx);
      return;
    }
    case 'restart': {
      if (!ctx.isHost) return 'Только хост';
      for (const id of Object.keys(s.points)) s.points[id] = 0;
      s.herd = {};
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
  const open = s.phase === 'review';
  let groups = null;
  let preview = null;
  if (open) {
    const sc = score(s.groupOf);
    const by = {};
    for (const [p, gid] of Object.entries(s.groupOf)) (by[gid] = by[gid] || []).push(p);
    groups = Object.entries(by)
      .map(([gid, pids]) => ({ gid, pids, texts: [...new Set(pids.map((p) => s.answers[p]))], major: gid === sc.majority }))
      .sort((a, b) => b.pids.length - a.pids.length);
    preview = sc.got;
  }
  return {
    phase: s.phase,
    round: s.round,
    rounds: s.rounds,
    endsAt: s.endsAt,
    phaseMs: s.phaseMs,
    q: s.q,
    answered: Object.keys(s.answers || {}),
    mine: s.answers?.[pid] ?? null,
    groups,
    preview,
    ready: Object.keys(s.ready || {}).filter((id) => s.ready[id]),
    inGame: s.order.includes(pid),
    order: s.order,
    points: s.points,
    winners: s.winners || null,
  };
}

function onLeave(s, pid, ctx) {
  s.order = s.order.filter((x) => x !== pid);
  delete s.points[pid];
  delete s.answers[pid];
  delete s.groupOf[pid];
  delete s.herd[pid];
  if (s.ready) delete s.ready[pid];
  if (s.phase === 'answer' && s.order.length && online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
}
const onPresence = (s, ctx) => {
  if (s.phase === 'answer' && online(s, ctx).length && online(s, ctx).every((id) => s.answers[id] != null)) reveal(s, ctx);
};
function pause(s, ctx) {
  if (!s.endsAt) return;
  s._left = Math.max(0, s.endsAt - Date.now());
  ctx.clearTimer('maj');
}
function resume(s, ctx) {
  if (s._left == null) return;
  const left = s._left;
  s._left = null;
  if (s.phase === 'answer') setTimer(s, ctx, left, () => reveal(s, ctx));
  else if (s.phase === 'review') setTimer(s, ctx, left, () => advance(s, ctx));
}

const isOver = (s) => s.phase === 'over';
const results = (s) => ({ ...s.points });
const stats = (s) => ({ herd: { ...s.herd } });

module.exports = { meta, create, action, view, onLeave, onPresence, isOver, results, stats, pause, resume, key, similar, autoGroups, score };
