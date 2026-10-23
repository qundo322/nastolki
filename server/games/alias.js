const { WORDS } = require('../words');
const { shuffle, Deck, clampInt, customWords, countLabel } = require('../util');

const TEAM_NAMES = ['Совы', 'Еноты', 'Лисы', 'Бобры', 'Пумы'];

const meta = {
  title: 'Элиас',
  emoji: '🎩',
  players: '4–20',
  content: countLabel(WORDS.length, 'слово', 'слова', 'слов'),
  short: 'Объясни команде как можно больше слов за минуту, не называя однокоренных.',
  rules: [
    'Игроки делятся на команды. В свой ход объясняющий видит слово и объясняет его своей команде голосом — без однокоренных слов, переводов и подсказок по буквам.',
    'Соперники видят слово и следят за честностью. Объясняющий в команде меняется каждый ход.',
    'Очки за ход подтверждает команда соперников — она следит, чтобы всё было честно. Когда время выходит, последнее слово становится общим: без таймера его угадывают все команды, а слово видит только объясняющий. Он отмечает, какая команда угадала первой, — тогда слово открывается всем. Затем соперники проверяют список и подтверждают очки.',
    'Очки команды: угаданное слово +1, пропуск −1 (если включён штраф). Последнее слово, угаданное соперниками, — +1 им.',
    'Побеждает команда, первой набравшая нужное число очков (проверяется в конце круга, чтобы у всех было одинаково ходов).',
    'В марафоне: команда-победитель — 1-е место (+3 каждому), вторая по очкам — +2, третья — +1.',
  ],
  restartActions: ['restart'],
  settings: [
    { key: 'teams', label: 'Команд', type: 'select', options: [2, 3, 4, 5], default: 2 },
    { key: 'seconds', label: 'Секунд на ход', type: 'select', options: [30, 45, 60, 90, 120], default: 60 },
    { key: 'target', label: 'Очков до победы', type: 'select', options: [20, 30, 40, 50, 75, 100], default: 40 },
    { key: 'penalty', label: 'Штраф за пропуск', type: 'checkbox', default: true },
    { key: 'customWords', label: 'Свои слова (через запятую, необязательно)', type: 'textarea' },
  ],
};

function create(ctx, st) {
  const nTeams = clampInt(st.teams, 2, 5, 2);
  const s = {
    seconds: clampInt(st.seconds, 15, 300, 60),
    target: clampInt(st.target, 5, 500, 40),
    penalty: st.penalty !== false,
    deck: new Deck([...customWords(st.customWords), ...WORDS]),
    teams: Array.from({ length: nTeams }, (_, i) => ({ name: TEAM_NAMES[i], members: [], score: 0, next: 0 })),
    phase: 'teams', // teams | ready | running | review | over
    turnTeam: 0,
    explainer: null,
    endsAt: null,
    word: null,
    turnWords: [],
    history: [],
    brought: {}, // pid → сколько очков принёс своей команде, объясняя
  };
  shuffle(ctx.players().map((p) => p.id)).forEach((id, i) => s.teams[i % nTeams].members.push(id));
  return s;
}

const teamOf = (s, pid) => s.teams.findIndex((t) => t.members.includes(pid));

function prepareTurn(s, ctx) {
  // Пропускаем пустые команды
  for (let k = 0; k < s.teams.length; k++) {
    const t = s.teams[s.turnTeam];
    const alive = t.members.filter((id) => ctx.room.players.get(id));
    if (alive.length) {
      t.next %= alive.length;
      s.explainer = alive[t.next];
      s.phase = 'ready';
      s.word = null;
      s.turnWords = [];
      s.confirms = {};
      return;
    }
    s.turnTeam = (s.turnTeam + 1) % s.teams.length;
  }
  s.phase = 'teams';
}

function endTimer(s) {
  if (s.phase !== 'running') return;
  s.paused = false;
  s.endsAt = null;
  // Время вышло, но слово на руках — «последнее слово»: без таймера, общее для всех команд.
  // Слово остаётся секретом, пока объясняющий не отметит, какая команда его угадала
  if (s.word) {
    s.phase = 'last';
    s.lastWord = s.word;
  } else s.phase = 'review';
  s.word = null;
}

function action(s, pid, msg, ctx) {
  const isExpl = pid === s.explainer;
  switch (msg.type) {
    case 'join': {
      if (s.phase === 'running' && isExpl) return 'Нельзя менять команду во время своего хода';
      const ti = clampInt(msg.team, 0, s.teams.length - 1, 0);
      s.teams.forEach((t) => (t.members = t.members.filter((m) => m !== pid)));
      s.teams[ti].members.push(pid);
      return;
    }
    case 'shuffleTeams': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'teams') return 'Команды можно перемешать только до начала';
      s.teams.forEach((t) => (t.members = []));
      shuffle(ctx.players().map((p) => p.id)).forEach((id, i) => s.teams[i % s.teams.length].members.push(id));
      return;
    }
    case 'begin': {
      if (!ctx.isHost) return 'Только хост';
      if (s.teams.filter((t) => t.members.length).length < 2) return 'Нужно минимум две непустые команды';
      prepareTurn(s, ctx);
      return;
    }
    case 'go': {
      if (s.phase !== 'ready') return;
      if (!isExpl && !ctx.isHost) return 'Начинает объясняющий';
      s.phase = 'running';
      s.word = s.deck.draw();
      s.endsAt = Date.now() + s.seconds * 1000;
      ctx.setTimer('turn', s.seconds * 1000, () => endTimer(s));
      return;
    }
    case 'got':
    case 'skip': {
      if (!isExpl) return 'Это кнопки объясняющего';
      if (s.paused) return 'Ход на паузе';
      if (s.phase === 'running') {
        s.turnWords.push({ w: s.word, ok: msg.type === 'got' });
        s.word = s.deck.draw();
      }
      return;
    }
    case 'toggle': {
      // Слова отмечает объясняющий (хост — только если объясняющий пропал из сети)
      if (s.phase !== 'review') return;
      if (!canMark(s, pid, ctx)) return 'Слова отмечает объясняющий';
      s.confirms = {};
      const w = s.turnWords[msg.i];
      if (!w) return;
      if (w.last) {
        // Последнее слово: никто / своя команда / соперники (если угадал кто-то из чужих)
        const states = [false, 'own', ...s.teams.map((_, i) => i).filter((i) => i !== s.turnTeam)];
        const cur = states.findIndex((x) => x === (w.ok === true ? 'own' : w.ok));
        w.ok = states[(cur + 1) % states.length];
        w.set = true;
      } else w.ok = !w.ok;
      return;
    }
    case 'lastTo': {
      // Последнее слово: сразу выбрать, кто угадал — своя команда, соперники или никто
      if (s.phase !== 'review' && s.phase !== 'last') return;
      if (!canMark(s, pid, ctx)) return 'Кто угадал последнее слово, отмечает объясняющий';
      s.confirms = {};
      if (s.phase === 'last') {
        s.turnWords.push({ w: s.lastWord, ok: false, last: true });
        s.lastWord = null;
        s.phase = 'review';
      }
      const w = s.turnWords.find((x) => x.last);
      if (!w) return;
      const to = msg.to;
      if (to === 'none') w.ok = false;
      else {
        const i = clampInt(to, 0, s.teams.length - 1, s.turnTeam);
        w.ok = i === s.turnTeam ? 'own' : i;
      }
      w.set = true;
      return;
    }
    case 'confirm': {
      // «Подтвердить очки» нажимают соперники (проверяют честность); хост может подтвердить за всех (force)
      if (s.phase !== 'review') return;
      if (!(msg.force && ctx.isHost)) {
        if (teamOf(s, pid) === -1) return 'Подтверждают игроки команд';
        const who = confirmers(s, ctx);
        if (who.length && !who.includes(pid)) return 'Очки подтверждает команда соперников';
        s.confirms = s.confirms || {};
        if (s.confirms[pid]) delete s.confirms[pid];
        else s.confirms[pid] = true;
        if (!confirmers(s, ctx).every((id) => s.confirms[id])) return;
      }
      applyConfirm(s, ctx);
      return;
    }
    case 'addTime': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'running') return;
      if (s.paused) s.pausedLeft += 15000;
      else {
        s.endsAt += 15000;
        ctx.setTimer('turn', s.endsAt - Date.now(), () => endTimer(s));
      }
      s.seconds = Math.max(s.seconds, Math.ceil(((s.paused ? s.pausedLeft : s.endsAt - Date.now())) / 1000));
      return;
    }
    case 'pauseTurn': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'running') return;
      if (!s.paused) {
        s.pausedLeft = Math.max(0, s.endsAt - Date.now());
        s.paused = true;
        ctx.clearTimer('turn');
      } else {
        s.paused = false;
        s.endsAt = Date.now() + s.pausedLeft;
        ctx.setTimer('turn', s.pausedLeft, () => endTimer(s));
      }
      return;
    }
    case 'newWord': {
      // Хост меняет слово без очков и штрафа (например, слово непонятное)
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'running') return;
      s.word = s.deck.draw();
      return;
    }
    case 'skipTurn': {
      if (!ctx.isHost) return 'Только хост';
      ctx.clearTimer('turn');
      s.teams[s.turnTeam].next++;
      s.turnTeam = (s.turnTeam + 1) % s.teams.length;
      prepareTurn(s, ctx);
      return;
    }
    case 'restart': {
      if (!ctx.isHost) return 'Только хост';
      ctx.clearTimer('turn');
      s.teams.forEach((t) => ((t.score = 0), (t.next = 0)));
      s.turnTeam = 0;
      s.history = [];
      s.brought = {};
      s.winner = null;
      s.phase = 'teams';
      return;
    }
  }
  return 'Неизвестное действие';
}

function applyConfirm(s, ctx) {
  s.confirms = {};
  const t = s.teams[s.turnTeam];
  let pts = 0;
  for (const w of s.turnWords) {
    if (w.last) {
      if (w.ok === 'own') pts++;
      else if (typeof w.ok === 'number') s.teams[w.ok].score++;
    } else if (w.ok) pts++;
    else if (s.penalty) pts--;
  }
  t.score += pts;
  s.brought = s.brought || {};
  s.brought[s.explainer] = (s.brought[s.explainer] || 0) + pts;
  s.history.push({ team: s.turnTeam, explainer: s.explainer, pts, n: s.turnWords.length });
  t.next++;
  s.turnTeam = (s.turnTeam + 1) % s.teams.length;
  if (s.turnTeam === 0) {
    const best = Math.max(...s.teams.map((x) => x.score));
    const leaders = s.teams.filter((x) => x.score === best);
    if (best >= s.target && leaders.length === 1) {
      s.phase = 'over';
      s.winner = s.teams.indexOf(leaders[0]);
      return;
    }
  }
  prepareTurn(s, ctx);
}

// Кто подтверждает очки — соперники ходившей команды, кто в сети (они следят за честностью).
// Если соперников в сети нет — подтверждает любой игрок команд
const online = (ctx, id) => ctx.room.players.get(id) && ctx.room.players.get(id).connected !== false;
const confirmers = (s, ctx) => {
  const rivals = s.teams.flatMap((t, i) => (i === s.turnTeam ? [] : t.members)).filter((id) => online(ctx, id));
  return rivals.length ? rivals : s.teams.flatMap((t) => t.members).filter((id) => online(ctx, id));
};
function canMark(s, pid, ctx) {
  if (pid === s.explainer) return true;
  const ex = ctx.room.players.get(s.explainer);
  return ctx.isHost && (!ex || ex.connected === false);
}
// Очки хода «вживую»: сколько получит каждая команда, если подтвердить прямо сейчас
function liveDelta(s) {
  const d = s.teams.map(() => 0);
  if (!['running', 'review'].includes(s.phase)) return d;
  for (const w of s.turnWords || []) {
    if (w.last) {
      if (w.ok === 'own') d[s.turnTeam]++;
      else if (typeof w.ok === 'number') d[w.ok]++;
    } else if (w.ok) d[s.turnTeam]++;
    else if (s.penalty) d[s.turnTeam]--;
  }
  return d;
}

function view(s, pid, ctx) {
  const my = teamOf(s, pid);
  const seesWord = pid === s.explainer; // слово видит только объясняющий — ни своя команда, ни соперники
  return {
    teams: s.teams.map((t) => ({ name: t.name, members: t.members, score: t.score })),
    live: liveDelta(s),
    confirms: Object.keys(s.confirms || {}),
    confirmers: ctx ? confirmers(s, ctx) : [],
    myTeam: my,
    phase: s.phase,
    turnTeam: s.turnTeam,
    explainer: s.explainer,
    endsAt: s.paused ? null : s.endsAt,
    paused: !!s.paused,
    pausedLeft: s.paused ? s.pausedLeft : null,
    seconds: s.seconds,
    target: s.target,
    penalty: s.penalty,
    word: s.phase === 'running' && seesWord ? s.word : s.phase === 'last' && seesWord ? s.lastWord : null,
    turnWords: s.phase === 'review' || seesWord ? s.turnWords : s.turnWords.map(() => ({ hidden: true })),
    guessedNow: s.turnWords.filter((w) => w.ok === true).length,
    skippedNow: s.turnWords.filter((w) => w.ok === false && !w.last).length,
    winner: s.winner ?? null,
    history: s.history.slice(-20),
    brought: s.brought || {},
  };
}

function onLeave(s, pid, ctx) {
  s.teams.forEach((t) => (t.members = t.members.filter((m) => m !== pid)));
  if (pid === s.explainer && ['ready', 'running', 'last', 'review'].includes(s.phase)) {
    ctx.clearTimer('turn');
    prepareTurn(s, ctx);
  }
}

// Кто-то вышел из сети, а остальные уже подтвердили — продолжаем
function onPresence(s, ctx) {
  if (s.phase === 'review' && Object.keys(s.confirms || {}).length && confirmers(s, ctx).every((id) => s.confirms[id])) applyConfirm(s, ctx);
}
const isOver = (s) => s.phase === 'over';
const results = (s) => {
  const out = {};
  s.teams.forEach((t) => t.members.forEach((id) => (out[id] = t.score)));
  return out;
};

// Пауза при уходе в лобби: запоминаем остаток времени хода
function pause(s) {
  if (s.phase === 'running' && s.endsAt) s._left = Math.max(0, s.endsAt - Date.now());
}
function resume(s, ctx) {
  if (s.phase === 'running' && s._left != null) {
    s.endsAt = Date.now() + s._left;
    ctx.setTimer('turn', s._left, () => endTimer(s));
  }
  s._left = null;
}

// Для номинаций марафона: очки, заработанные объяснением
function stats(s) {
  const explainer = {};
  for (const h of s.history) if (h.pts > 0) explainer[h.explainer] = (explainer[h.explainer] || 0) + h.pts;
  return { explainer };
}

module.exports = { meta, create, action, view, onLeave, onPresence, isOver, results, pause, resume, stats };
