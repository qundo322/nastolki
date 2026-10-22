const { CHARACTERS } = require('../words');
const { shuffle, Deck, countLabel } = require('../util');
const Avatars = require('../avatars'); // картинки персонажей хранятся там же, где аватарки

const Q_MS = 60000; // минута на один вопрос

const meta = {
  title: 'Кто я?',
  emoji: '🤔',
  players: '3–20',
  content: countLabel(CHARACTERS.length, 'персонаж', 'персонажа', 'персонажей'),
  short: 'У тебя на лбу персонаж — все его видят, кроме тебя. Угадай вопросами «да/нет».',
  rules: [
    'Каждому игроку достаётся персонаж: его видят все, кроме самого игрока. Персонажей раздают случайно или каждый загадывает персонажа соседу.',
    'В свой ход пиши вопросы, на которые можно ответить «да» или «нет». Остальные отвечают кнопками «Да / Нет / Не знаю» — вопрос и ответ попадают в твою историю.',
    'Когда ответили все: больше «да» — задавай следующий вопрос; больше «нет» — ход переходит дальше. Если большинство уже ответило одинаково — решение принимается сразу, остальных не ждём. Если «да» и «нет» поровну — ждём, пока игроки договорятся. На то, чтобы придумать вопрос, — минута; не успел — ход переходит.',
    'Думаешь, что знаешь ответ, — назови персонажа вслух. Угадал — нажми «Я угадал», и персонаж откроется тебе.',
    'Очки: угадал персонажа — +1. Бонус за скорость: первый угадавший +2, второй +1. Сдался — 0.',
  ],
  restartActions: [],
  settings: [
    {
      key: 'mode',
      label: 'Кто загадывает',
      type: 'select',
      options: [
        { v: 'write', t: 'Игроки загадывают друг другу' },
        { v: 'random', t: 'Случайные персонажи' },
      ],
      default: 'write',
    },
  ],
};

function create(ctx, st) {
  const ids = shuffle(ctx.players().map((p) => p.id));
  if (ids.length < 2) return 'Нужно минимум 2 игрока';
  const s = {
    mode: st.mode === 'random' ? 'random' : 'write',
    order: ids,
    turn: 0,
    a: {}, // pid -> {char, writer, guessedAt, gaveUp}
    deck: new Deck(CHARACTERS),
    finishOrder: [],
    q: null, // текущий вопрос: {id, asker, text, answers: {pid: 'yes'|'no'|'idk'}}
    qn: 0,
  };
  ids.forEach((id, i) => {
    s.a[id] = { char: s.mode === 'random' ? s.deck.draw() : null, writer: ids[(i + ids.length - 1) % ids.length], qa: [] };
  });
  s.phase = s.mode === 'random' ? 'play' : 'write';
  if (s.phase === 'play') startQ(s, ctx);
  return s;
}

const active = (s, ctx) => s.order.filter((id) => ctx.room.players.get(id));

// Вопрос с ответами уходит в историю того, кто спрашивал
const ANS = ['yes', 'no', 'idk'];
function tally(q) {
  const t = { yes: 0, no: 0, idk: 0 };
  for (const v of Object.values(q.answers)) t[v]++;
  return t;
}
// Итог вопроса: больше «да» — да, больше «нет» — нет; иначе — непонятно
function verdict(t) {
  if (t.yes > t.no) return 'yes';
  if (t.no > t.yes) return 'no';
  return t.yes || t.no || t.idk ? 'idk' : null;
}
function archive(s) {
  const q = s.q;
  s.q = null;
  s.pend = null;
  if (!q || !Object.keys(q.answers).length) return;
  const t = tally(q);
  const a = s.a[q.asker];
  if (a) {
    a.qa.push({ text: q.text, ...t, v: verdict(t) });
    if (a.qa.length > 40) a.qa.shift();
  }
}
function newQ(s, asker, text) {
  archive(s);
  s.q = { id: ++s.qn, asker, text: String(text || '').trim().slice(0, 120), answers: {} };
}
// Таймер вопроса: минута на каждый вопрос, вышло время — ход переходит
function startQ(s, ctx) {
  ctx.clearTimer('who-q');
  if (s.phase !== 'play') return (s.qEnds = null);
  s.qEnds = Date.now() + Q_MS;
  ctx.setTimer('who-q', Q_MS, () => {
    if (s.phase !== 'play') return;
    advance(s, ctx);
  });
}
// Кто должен ответить: все в игре и в сети, кроме спрашивающего
const voters = (s, ctx) => Object.keys(s.a).filter((id) => id !== s.order[s.turn] && ctx.room.players.get(id) && ctx.room.players.get(id).connected !== false);
const PEND_MS = 2000; // как открытие карточки в Коднеймс: 2 секунды, чтобы успеть передумать
function cancelPend(s, ctx) {
  if (s.pend) {
    s.pend = null;
    ctx.clearTimer('who-pend');
  }
}
// Ответили все → решение («да» — следующий вопрос, «нет» — ход дальше) засчитывается через 2 секунды
function checkAnswers(s, ctx) {
  const q = s.q;
  if (!q || s.phase !== 'play') return cancelPend(s, ctx);
  const need = voters(s, ctx);
  if (!need.length) return cancelPend(s, ctx);
  const t = tally(q);
  // Большинство уже ответило одинаково — не ждём тех, кто задумался
  const half = Math.floor(need.length / 2) + 1;
  let v = t.yes >= half ? 'yes' : t.no >= half ? 'no' : null;
  if (!v) {
    if (!need.every((id) => q.answers[id])) return cancelPend(s, ctx);
    if (t.yes === t.no && t.yes > 0) return cancelPend(s, ctx); // поровну — ждём, пока договорятся
    v = verdict(t);
  }
  if (s.pend && s.pend.qid === q.id && s.pend.v === v) return; // отсчёт уже идёт
  cancelPend(s, ctx);
  s.pend = { qid: q.id, v, at: Date.now() + PEND_MS, ms: PEND_MS };
  ctx.setTimer('who-pend', PEND_MS, () => {
    if (!s.pend || !s.q || s.q.id !== s.pend.qid) return;
    const fin = s.pend.v;
    s.pend = null;
    if (fin === 'no') advance(s, ctx); // «нет» — ход дальше
    else {
      archive(s); // «да» (или «не знаю») — следующий вопрос
      startQ(s, ctx);
    }
  });
}

function advance(s, ctx) {
  archive(s);
  const act = active(s, ctx);
  if (act.length) {
    for (let k = 0; k < s.order.length; k++) {
      s.turn = (s.turn + 1) % s.order.length;
      const id = s.order[s.turn];
      const a = s.a[id];
      if (ctx.room.players.get(id) && !a.guessedAt && !a.gaveUp) break;
    }
  }
  startQ(s, ctx);
}

function action(s, pid, msg, ctx) {
  switch (msg.type) {
    case 'write': {
      if (s.phase !== 'write') return 'Персонажи уже розданы';
      const target = Object.keys(s.a).find((id) => s.a[id].writer === pid);
      if (!target) return 'Вам некому загадывать';
      const text = String(msg.text || '').trim().slice(0, 60);
      if (!text) return 'Введите персонажа';
      if (s.a[target].char) return 'Персонаж уже загадан';
      s.a[target].char = text;
      s.a[target].img = Avatars.clean(msg.img); // необязательная картинка персонажа
      if (Object.values(s.a).every((a) => a.char)) {
        s.phase = 'play';
        startQ(s, ctx);
      }
      return;
    }
    case 'randomFor': {
      if (s.phase !== 'write') return;
      const target = Object.keys(s.a).find((id) => s.a[id].writer === pid);
      if (target && !s.a[target].char) s.a[target].char = s.deck.draw();
      if (Object.values(s.a).every((a) => a.char)) {
        s.phase = 'play';
        startQ(s, ctx);
      }
      return;
    }
    case 'forceStart': {
      if (!ctx.isHost) return 'Только хост';
      for (const a of Object.values(s.a)) if (!a.char) a.char = s.deck.draw();
      s.phase = 'play';
      startQ(s, ctx);
      return;
    }
    case 'ask': {
      if (s.phase !== 'play') return;
      if (s.order[s.turn] !== pid) return 'Сейчас спрашивает другой игрок';
      if (!String(msg.text || '').trim()) return 'Напишите вопрос';
      if (s.q && !Object.keys(s.q.answers).length) s.q.text = String(msg.text).trim().slice(0, 120); // поправить ещё не отвеченный
      else newQ(s, pid, msg.text);
      // Минута — только на то, чтобы придумать вопрос; пока отвечают, таймер не идёт
      ctx.clearTimer('who-q');
      s.qEnds = null;
      return;
    }
    case 'answer': {
      if (s.phase !== 'play') return;
      if (!s.a[pid]) return;
      const asker = s.order[s.turn];
      if (pid === asker) return 'На свой вопрос отвечают другие';
      if (!ANS.includes(msg.v)) return;
      if (!s.q || s.q.asker !== asker) return 'Вопроса ещё нет';
      if (s.q.answers[pid] === msg.v) delete s.q.answers[pid];
      else s.q.answers[pid] = msg.v;
      checkAnswers(s, ctx);
      return;
    }
    case 'addTime': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'play' || !s.qEnds) return;
      s.qEnds += 30000;
      ctx.setTimer('who-q', s.qEnds - Date.now(), () => s.phase === 'play' && advance(s, ctx));
      return;
    }
    case 'clearVotes': {
      if (!ctx.isHost) return 'Только хост';
      if (!s.q) return;
      s.q.answers = {};
      cancelPend(s, ctx);
      return;
    }
    case 'skipQ': {
      // Вопрос не засчитывается (например, непонятный) — спрашивающий задаёт новый
      if (!ctx.isHost) return 'Только хост';
      if (!s.q) return;
      s.q = null;
      cancelPend(s, ctx);
      startQ(s, ctx);
      return;
    }
    case 'next': {
      if (s.phase !== 'play') return;
      if (s.order[s.turn] !== pid && !ctx.isHost) return 'Передать ход может игрок, который ходит';
      advance(s, ctx);
      return;
    }
    case 'guessed':
    case 'giveUp': {
      if (s.phase !== 'play') return;
      const a = s.a[pid];
      if (!a || a.guessedAt || a.gaveUp) return;
      if (msg.type === 'guessed') {
        a.guessedAt = Date.now();
        s.finishOrder.push(pid);
      } else a.gaveUp = true;
      if (s.order[s.turn] === pid) advance(s, ctx);
      if (Object.entries(s.a).every(([id, x]) => x.guessedAt || x.gaveUp || !ctx.room.players.get(id))) {
        s.phase = 'over';
        ctx.clearTimer('who-q');
        s.qEnds = null;
      }
      return;
    }
    case 'addMe': {
      // Опоздавший игрок получает случайного персонажа
      if (s.a[pid]) return;
      s.order.push(pid);
      s.a[pid] = { char: s.deck.draw(), writer: null, qa: [] };
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid) {
  const me = s.a[pid];
  const target = Object.keys(s.a).find((id) => s.a[id].writer === pid);
  return {
    phase: s.phase,
    mode: s.mode,
    order: s.order,
    turnPid: s.order[s.turn],
    inGame: !!me,
    writeFor: s.phase === 'write' ? target || null : null,
    writtenForTarget: s.phase === 'write' && target ? !!s.a[target].char : false,
    pending: s.phase === 'write' ? Object.values(s.a).filter((a) => !a.char).map((a) => a.writer) : [],
    finishOrder: s.finishOrder,
    points: points(s),
    qEnds: s.phase === 'play' ? s.qEnds : null,
    q: s.q && s.phase === 'play' ? { id: s.q.id, asker: s.q.asker, text: s.q.text, ...tally(s.q), mine: s.q.answers[pid] || null, who: s.q.answers, split: tally(s.q).yes === tally(s.q).no && tally(s.q).yes > 0, pend: s.pend && s.pend.qid === s.q.id ? { v: s.pend.v, at: s.pend.at, ms: s.pend.ms } : null } : null,
    players: Object.fromEntries(
      Object.entries(s.a).map(([id, a]) => [
        id,
        {
          char: s.phase === 'write' ? null : id === pid && !a.guessedAt && !a.gaveUp && s.phase !== 'over' ? null : a.char,
          img: s.phase === 'write' ? null : id === pid && !a.guessedAt && !a.gaveUp && s.phase !== 'over' ? null : a.img || null,
          writer: a.writer,
          guessed: !!a.guessedAt,
          gaveUp: !!a.gaveUp,
          qa: a.qa.slice(-12),
        },
      ])
    ),
  };
}

// Вышел или выгнан — полностью убираем из катки
function onLeave(s, pid, ctx) {
  if (!s.a[pid]) return;
  const cur = s.order[s.turn];
  const wasTurn = cur === pid;
  if (wasTurn) archive(s);
  // кому он должен был загадать — получает случайного персонажа
  for (const a of Object.values(s.a)) if (a.writer === pid) {
    a.writer = null;
    if (!a.char) a.char = s.deck.draw();
  }
  const idx = s.order.indexOf(pid);
  s.order = s.order.filter((x) => x !== pid);
  delete s.a[pid];
  s.finishOrder = s.finishOrder.filter((x) => x !== pid);
  if (s.q) {
    delete s.q.answers[pid];
    if (s.q.asker === pid) s.q = null;
  }
  if (!s.order.length) return;
  s.turn = wasTurn ? (idx - 1 + s.order.length) % s.order.length : Math.max(0, s.order.indexOf(cur));
  if (s.phase === 'write' && Object.values(s.a).every((a) => a.char)) {
    s.phase = 'play';
    startQ(s, ctx);
  }
  if (s.phase === 'play' && Object.entries(s.a).every(([, x]) => x.guessedAt || x.gaveUp)) {
    s.phase = 'over';
    ctx.clearTimer('who-q');
    s.qEnds = null;
    return;
  }
  if (wasTurn) advance(s, ctx); // ход переходит следующему
  else checkAnswers(s, ctx);
}
const onPresence = (s, ctx) => checkAnswers(s, ctx);
// Пауза (лобби): таймер вопроса замирает
function pause(s, ctx) {
  if (!s.qEnds) return;
  s._left = Math.max(0, s.qEnds - Date.now());
  ctx.clearTimer('who-q');
}
function resume(s, ctx) {
  if (s._left == null || s.phase !== 'play') return;
  s.qEnds = Date.now() + s._left;
  ctx.setTimer('who-q', s._left, () => s.phase === 'play' && advance(s, ctx));
  s._left = null;
}

function points(s) {
  const out = {};
  for (const [id, a] of Object.entries(s.a)) {
    let p = a.guessedAt ? 1 : 0;
    const place = s.finishOrder.indexOf(id);
    if (place === 0) p += 2;
    else if (place === 1) p += 1;
    out[id] = p;
  }
  return out;
}
const isOver = (s) => s.phase === 'over';
const results = (s) => points(s);

// Для номинаций марафона
const stats = (s) => ({ sherlock: s.finishOrder.length ? { [s.finishOrder[0]]: 1 } : {} });

module.exports = { meta, create, action, view, onLeave, isOver, results, points, stats, onPresence, pause, resume };
