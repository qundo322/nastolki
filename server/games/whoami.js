const { CHARACTERS } = require('../words');
const { shuffle, Deck } = require('../util');

const meta = {
  title: 'Кто я?',
  emoji: '🤔',
  players: '3–20',
  short: 'У тебя на лбу персонаж — все его видят, кроме тебя. Угадай вопросами «да/нет».',
  rules: [
    'Каждому игроку достаётся персонаж: его видят все, кроме самого игрока. Персонажей раздают случайно или каждый загадывает персонажа соседу.',
    'В свой ход задавай вопросы, на которые можно ответить «да» или «нет». После ответа «нет» нажми «Передать ход».',
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
  };
  ids.forEach((id, i) => {
    s.a[id] = { char: s.mode === 'random' ? s.deck.draw() : null, writer: ids[(i + ids.length - 1) % ids.length] };
  });
  s.phase = s.mode === 'random' ? 'play' : 'write';
  return s;
}

const active = (s, ctx) => s.order.filter((id) => ctx.room.players.get(id));

function advance(s, ctx) {
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
      s.a[pid] = { char: s.deck.draw(), writer: null };
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
    players: Object.fromEntries(
      Object.entries(s.a).map(([id, a]) => [
        id,
        {
          char: s.phase === 'write' ? null : id === pid && !a.guessedAt && !a.gaveUp && s.phase !== 'over' ? null : a.char,
          writer: a.writer,
          guessed: !!a.guessedAt,
          gaveUp: !!a.gaveUp,
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

module.exports = { meta, create, action, view, onLeave, isOver, results, points };
