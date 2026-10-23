const { shuffle } = require('../util');

// «Кости 1000» (домашняя «Тысяча»): 5 кубиков, по очереди бросаем, откладываем зачётные кости.
// Зачёт: «1» — 10, «5» — 5; три одинаковых — 1:100, иначе грань×10; четыре — вдвое больше; пять — 1:1000, иначе грань×100.
// Стриты (только все 5 кубиков одного броска): 1-2-3-4-5 — 125, 2-3-4-5-6 — 250.
// Допуск — первая запись не меньше 75. Бочка — 850: больше записать нельзя, дальше за один ход нужно 150.
// Кто встал на бочку — сбрасывает с бочки остальных на их допуск. Все 5 кубиков зачётные — подтверждающий бросок.
const TARGET = 1000;
const ENTRY = 75;
const BARREL = 850;
const BARREL_NEED = TARGET - BARREL; // 150
const ROLL_MS = 1200; // анимация броска
const BUST_MS = 2200; // показываем «пусто» перед переходом хода

const meta = {
  title: 'Кости 1000',
  emoji: '🎲',
  players: '2–10',
  content: '5 кубиков',
  short: 'Бросай 5 кубиков, откладывай единицы, пятёрки и комбинации. Кто первым наберёт 1000 — победил. Рискнёшь ещё раз?',
  rules: [
    'Ходят по очереди. Бросаете 5 кубиков и откладываете хотя бы одну зачётную кость: «1» — 10 очков, «5» — 5 очков, три одинаковых и больше — комбинация.',
    'Остальные кубики можно перебросить и набрать ещё — или записать набранное за ход. Если в броске нет ни одной зачётной кости — ход сгорает.',
    'Отложили все 5 кубиков — нужен подтверждающий бросок всеми пятью: есть зачётная кость — продолжаете, нет — ход сгорает.',
    'Допуск: первая запись — не меньше 75 очков за ход. Бочка: на 850 очки останавливаются, дальше нужно набрать 150 за один ход.',
    'Кто встал на бочку, сбрасывает с неё остальных — они возвращаются к своему допуску. Первый, кто наберёт 1000, побеждает.',
  ],
  restartActions: ['restart'],
  settings: [],
};

// ---- подсчёт очков ----
const COMBO = (face, n) => {
  if (n === 3) return face === 1 ? 100 : face * 10;
  if (n === 4) return face === 1 ? 200 : face * 20;
  if (n === 5) return face === 1 ? 1000 : face * 100;
  return 0;
};
// Очки за набор костей одного броска; null — если в наборе есть незачётная кость
function score(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b).join('');
  if (values.length === 5 && sorted === '12345') return 125;
  if (values.length === 5 && sorted === '23456') return 250;
  const cnt = [0, 0, 0, 0, 0, 0, 0];
  for (const v of values) cnt[v]++;
  let pts = 0;
  for (let f = 1; f <= 6; f++) {
    let n = cnt[f];
    if (n >= 3) {
      pts += COMBO(f, n);
      n = 0;
    }
    if (n) {
      if (f === 1) pts += 10 * n;
      else if (f === 5) pts += 5 * n;
      else return null; // одиночные 2, 3, 4, 6 не идут в зачёт
    }
  }
  return pts;
}
// Лучший набор из выпавших костей (индексы) — подсказка и проверка «пусто»
function best(dice) {
  const free = dice.map((d, i) => (d.kept ? -1 : i)).filter((i) => i >= 0);
  let top = { pts: 0, idx: [] };
  for (let mask = 1; mask < 1 << free.length; mask++) {
    const idx = free.filter((_, k) => mask & (1 << k));
    const p = score(idx.map((i) => dice[i].v));
    if (p != null && (p > top.pts || (p === top.pts && idx.length > top.idx.length))) top = { pts: p, idx };
  }
  return top;
}

const roll1 = () => 1 + Math.floor(Math.random() * 6);

function create(ctx) {
  const ids = shuffle(ctx.players().map((p) => p.id));
  if (ids.length < 2) return 'Для «Костей» нужно минимум 2 игрока';
  const s = {
    order: ids,
    turn: 0,
    total: Object.fromEntries(ids.map((id) => [id, 0])),
    entry: {}, // с каким счётом игрок прошёл допуск — туда сбрасывает с бочки
    log: [],
    winner: null,
  };
  newTurn(s);
  return s;
}

function newTurn(s) {
  s.phase = 'start'; // ждём первый бросок
  s.dice = Array.from({ length: 5 }, () => ({ v: roll1(), kept: false, fresh: false }));
  s.turnPts = 0;
  s.rolls = 0;
  s.rollId = (s.rollId || 0) + 1;
  s.rollAt = 0;
  s.bust = null;
}
const cur = (s) => s.order[s.turn];

function nextTurn(s, ctx) {
  for (let k = 0; k < s.order.length; k++) {
    s.turn = (s.turn + 1) % s.order.length;
    if (ctx.room.players.get(cur(s))?.connected !== false) break;
  }
  newTurn(s);
}

// Бросаем все свободные кубики
function doRoll(s, ctx, power) {
  s.power = Math.max(0, Math.min(1, Number(power) || 0)); // сила броска — только для анимации, на результат не влияет
  for (const d of s.dice) {
    d.fresh = !d.kept;
    if (!d.kept) d.v = roll1();
  }
  s.rolls++;
  s.rollId++;
  s.rollAt = Date.now();
  s.phase = 'pick';
  // Пусто — ход сгорает (после анимации)
  if (!best(s.dice).pts) {
    s.phase = 'bust';
    s.bust = { lost: s.turnPts };
    s.log.unshift({ pid: cur(s), kind: 'bust', pts: s.turnPts });
    s.log.length = Math.min(s.log.length, 12);
    ctx.setTimer('dice', ROLL_MS + BUST_MS, () => {
      if (s.phase === 'bust') nextTurn(s, ctx);
    });
  }
}

// Отложить выбранные кости (проверяем, что все зачётные)
function keep(s, idx) {
  const list = [...new Set((idx || []).map(Number))].filter((i) => s.dice[i] && !s.dice[i].kept);
  if (!list.length) return 'Отложите хотя бы одну зачётную кость';
  const pts = score(list.map((i) => s.dice[i].v));
  if (pts == null) return 'Отложить можно только зачётные кости: 1, 5 или комбинации';
  for (const i of list) s.dice[i].kept = true;
  s.turnPts += pts;
  return null;
}

// Можно ли записать набранное и сколько окажется на счёте
function canRecord(s, pid, pts) {
  const t = s.total[pid] || 0;
  if (!s.entry[pid] && pts < ENTRY) return `Допуск: для первой записи нужно минимум ${ENTRY} очков за ход`;
  if (t === BARREL && pts < BARREL_NEED) return `На бочке нужно набрать ${BARREL_NEED} очков за ход`;
  return null;
}

function record(s, ctx) {
  const pid = cur(s);
  const before = s.total[pid] || 0;
  let after = before + s.turnPts;
  let note = '';
  if (!s.entry[pid]) {
    s.entry[pid] = after;
    note = 'допуск';
  }
  if (before === BARREL) {
    after = TARGET;
  } else if (after >= BARREL) {
    after = BARREL;
    note = 'бочка';
    // Встал на бочку — сбрасывает с неё остальных к их допуску
    for (const id of s.order) {
      if (id !== pid && s.total[id] === BARREL) {
        s.total[id] = s.entry[id] || 0;
        s.log.unshift({ pid: id, kind: 'drop', by: pid, to: s.total[id] });
      }
    }
  }
  s.total[pid] = after;
  s.log.unshift({ pid, kind: 'rec', pts: s.turnPts, total: after, note });
  s.log.length = Math.min(s.log.length, 12);
  if (after >= TARGET) {
    s.phase = 'over';
    s.winner = pid;
    return;
  }
  nextTurn(s, ctx);
}

function action(s, pid, msg, ctx) {
  if (msg.type === 'restart') {
    if (!ctx.isHost) return 'Только хост';
    for (const id of s.order) s.total[id] = 0;
    s.entry = {};
    s.log = [];
    s.winner = null;
    s.turn = 0;
    newTurn(s);
    return;
  }
  if (msg.type === 'addMe') {
    if (s.order.includes(pid)) return;
    s.order.push(pid);
    s.total[pid] = 0;
    return;
  }
  if (msg.type === 'skipTurn') {
    if (!ctx.isHost) return 'Только хост';
    if (s.phase === 'over') return;
    ctx.clearTimer('dice');
    nextTurn(s, ctx);
    return;
  }
  if (s.phase === 'over') return 'Игра окончена';
  if (pid !== cur(s)) return 'Сейчас бросает другой игрок';
  if (Date.now() - s.rollAt < ROLL_MS - 200) return 'Кубики ещё катятся';
  switch (msg.type) {
    case 'roll': {
      if (s.phase === 'start') return doRoll(s, ctx, msg.power);
      if (s.phase !== 'pick') return;
      const err = keep(s, msg.keep);
      if (err) return err;
      // Отложены все пять — подтверждающий бросок всеми кубиками
      if (s.dice.every((d) => d.kept)) for (const d of s.dice) d.kept = false;
      return doRoll(s, ctx, msg.power);
    }
    case 'stop': {
      if (s.phase !== 'pick') return;
      const list = (msg.keep || []).map(Number);
      const idx = list.filter((i) => s.dice[i] && !s.dice[i].kept);
      const pts = score(idx.map((i) => s.dice[i].v));
      if (pts == null) return 'Отложить можно только зачётные кости: 1, 5 или комбинации';
      if (s.dice.every((d, i) => d.kept || idx.includes(i))) return 'Все 5 кубиков зачётные — нужен подтверждающий бросок';
      const err = canRecord(s, pid, s.turnPts + pts);
      if (err) return err;
      keep(s, idx);
      record(s, ctx);
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid) {
  const me = cur(s);
  const b = s.phase === 'pick' ? best(s.dice) : null;
  return {
    phase: s.phase,
    order: s.order,
    turnPid: me,
    total: s.total,
    entered: Object.fromEntries(s.order.map((id) => [id, !!s.entry[id]])),
    entry: ENTRY,
    barrel: BARREL,
    target: TARGET,
    dice: s.dice.map((d) => ({ v: d.v, kept: d.kept, fresh: d.fresh })),
    rollId: s.rollId,
    rollAt: s.rollAt,
    rollMs: ROLL_MS,
    power: s.power || 0,
    rolls: s.rolls,
    turnPts: s.turnPts,
    best: b ? b.idx : [],
    bestPts: b ? b.pts : 0,
    bust: s.bust,
    log: s.log.slice(0, 10),
    winner: s.winner,
    inGame: s.order.includes(pid),
  };
}

function onLeave(s, pid, ctx) {
  const wasTurn = cur(s) === pid;
  const idx = s.order.indexOf(pid);
  if (idx < 0) return;
  s.order.splice(idx, 1);
  delete s.total[pid];
  delete s.entry[pid];
  if (!s.order.length) return;
  if (idx < s.turn || s.turn >= s.order.length) s.turn = (s.turn - (idx < s.turn ? 1 : 0) + s.order.length) % s.order.length;
  if (wasTurn && s.phase !== 'over') {
    ctx.clearTimer('dice');
    s.turn = (s.turn - 1 + s.order.length) % s.order.length;
    nextTurn(s, ctx);
  }
}

const isOver = (s) => s.phase === 'over';
const results = (s) => ({ ...s.total });

module.exports = { meta, create, action, view, onLeave, isOver, results, score, best };
