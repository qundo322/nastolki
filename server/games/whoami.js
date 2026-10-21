const { CHARACTERS } = require('../words');
const { shuffle, Deck } = require('../util');

const meta = {
  title: 'Кто я?',
  emoji: '🤔',
  players: '3–20',
  short: 'У тебя на лбу персонаж — все его видят, кроме тебя. Угадай вопросами «да/нет».',
  rules: [
    'Каждому игроку достаётся персонаж: его видят все, кроме самого игрока. Персонажей раздают случайно или каждый загадывает персонажа соседу.',
    'В свой ход задавай вопросы, на которые можно ответить «да» или «нет». Вопрос можно напечатать или задать голосом. Остальные отвечают кнопками «Да / Нет / Не знаю» — вопрос и ответ сами попадают в твою историю. После ответа «нет» нажми «Передать ход».',
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
function verdict(t) {
  if (t.yes > t.no && t.yes >= t.idk) return 'yes';
  if (t.no > t.yes && t.no >= t.idk) return 'no';
  return t.yes || t.no || t.idk ? 'idk' : null;
}
function archive(s) {
  const q = s.q;
  s.q = null;
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

function advance(s, ctx) {
  archive(s);
  const act = active(s, ctx);
  if (!act.length) return;
  for (let k = 0; k < s.order.length; k++) {
    s.turn = (s.turn + 1) % s.order.length;
    const id = s.order[s.turn];
    const a = s.a[id];
    if (ctx.room.players.get(id) && !a.guessedAt && !a.gaveUp) return;
  }
}

function action(s, pid, msg, ctx) {
  switch (msg.type) {
    case 'write': {
      if (s.phase !== 'write') return 'Персонажи уже розданы';
      const target = Object.keys(s.a).find((id) => s.a[id].writer === pid);
      if (!target) return 'Вам некому загадывать';
      const text = String(msg.text || '').trim().slice(0, 60);
      if (!text) return 'Введите персонажа';
      s.a[target].char = text;
      if (Object.values(s.a).every((a) => a.char)) s.phase = 'play';
      return;
    }
    case 'randomFor': {
      if (s.phase !== 'write') return;
      const target = Object.keys(s.a).find((id) => s.a[id].writer === pid);
      if (target) s.a[target].char = s.deck.draw();
      if (Object.values(s.a).every((a) => a.char)) s.phase = 'play';
      return;
    }
    case 'forceStart': {
      if (!ctx.isHost) return 'Только хост';
      for (const a of Object.values(s.a)) if (!a.char) a.char = s.deck.draw();
      s.phase = 'play';
      return;
    }
    case 'ask': {
      if (s.phase !== 'play') return;
      if (s.order[s.turn] !== pid) return 'Сейчас спрашивает другой игрок';
      newQ(s, pid, msg.text);
      return;
    }
    case 'answer': {
      if (s.phase !== 'play') return;
      if (!s.a[pid]) return;
      const asker = s.order[s.turn];
      if (pid === asker) return 'На свой вопрос отвечают другие';
      if (!ANS.includes(msg.v)) return;
      if (!s.q || s.q.asker !== asker) newQ(s, asker, ''); // вопрос задан голосом
      if (s.q.answers[pid] === msg.v) delete s.q.answers[pid];
      else s.q.answers[pid] = msg.v;
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
      if (Object.entries(s.a).every(([id, x]) => x.guessedAt || x.gaveUp || !ctx.room.players.get(id))) s.phase = 'over';
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
    q: s.q && s.phase === 'play' ? { id: s.q.id, asker: s.q.asker, text: s.q.text, ...tally(s.q), mine: s.q.answers[pid] || null, who: s.q.answers } : null,
    players: Object.fromEntries(
      Object.entries(s.a).map(([id, a]) => [
        id,
        {
          char: s.phase === 'write' ? null : id === pid && !a.guessedAt && !a.gaveUp && s.phase !== 'over' ? null : a.char,
          writer: a.writer,
          guessed: !!a.guessedAt,
          gaveUp: !!a.gaveUp,
          qa: a.qa.slice(-12),
        },
      ])
    ),
  };
}

function onLeave(s, pid, ctx) {
  if (s.order[s.turn] === pid) advance(s, ctx);
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

module.exports = { meta, create, action, view, onLeave, isOver, results, points, stats };
