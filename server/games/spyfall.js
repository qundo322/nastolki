const { LOCATIONS } = require('../words');
const { shuffle, pick, clampInt } = require('../util');


const meta = {
  title: 'Шпион',
  emoji: '🕶️',
  players: '3–20',
  short: 'Все знают локацию, кроме шпиона. Вычислите его вопросами — или он вычислит место.',
  rules: [
    'Каждый получает карточку с локацией и своей ролью, а шпион — только надпись «Вы шпион». Списка локаций нет — шпиону придётся догадаться по разговору.',
    'Вопросы идут по очереди: спрашивающий выбирает на сайте, кого спросить, тот отвечает вслух и жмёт «Ответил» — теперь спрашивает он. Сразу спросить того, кто только что спросил тебя, нельзя. Рядом с игроками видно, сколько вопросов им задали — молчуны подсвечены.',
    'Голосование: нажмите «Обвинить» напротив игрока. Когда за кого-то проголосовали все остальные — раунд заканчивается. Голос можно отозвать.',
    'Если шпион уверен, он жмёт «Я знаю локацию» и называет её вслух в Discord. Мирные игроки решают кнопками «Шпион угадал» / «Шпион не угадал» — решает большинство. Голосование на это время замораживается.',
    'Очки за раунд: шпион угадал локацию — шпиону +3. Обвинили невиновного — шпиону +2. Шпиона поймали голосованием или он ошибся с локацией — каждому мирному +1. Бонус: мирный, чей голос в конце раунда стоит на шпионе, — ещё +1.',
    'В марафоне раунд — это одна катка; места считаются по очкам раунда.',
  ],
  restartActions: ['next'],
  settings: [
    { key: 'minutes', label: 'Минут на раунд', type: 'select', options: [5, 6, 7, 8, 10, 12, 15], default: 8 },
    { key: 'spies', label: 'Шпионов', type: 'select', options: [1, 2, 3], default: 1 },
  ],
};

function deal(s, ctx) {
  const ids = shuffle(ctx.players().map((p) => p.id));
  const [loc, roles] = pick(LOCATIONS);
  s.location = loc;
  const spyCount = Math.min(s.spyCount, Math.max(1, ids.length - 2));
  s.spies = ids.slice(0, spyCount);
  const rolePool = shuffle(roles);
  s.roles = {};
  ids.forEach((id, i) => (s.roles[id] = i < spyCount ? null : rolePool[(i - spyCount) % rolePool.length]));
  s.participants = ids;
  s.votes = {};
  s.phase = 'play'; // play | guessing | over
  s.result = null;
  s.claim = null;
  s.roundPts = {};
  s.endsAt = Date.now() + s.minutes * 60000;
  s.round++;
  s.roundPaused = false;
  s.firstAsks = pick(ids);
  // Очередь вопросов: спрашивающий выбирает, кого спросить; ответивший спрашивает следующим
  s.asker = s.firstAsks;
  s.target = null;
  s.prev = null; // кто спросил текущего — ему нельзя сразу задать встречный вопрос
  s.asked = Object.fromEntries(ids.map((id) => [id, 0]));
  s.qlog = [];
}
const alivePart = (s, ctx) => s.participants.filter((id) => ctx.room.players.get(id));

function create(ctx, st) {
  if (ctx.players().length < 3) return 'Для «Шпиона» нужно минимум 3 игрока';
  const s = { minutes: clampInt(st.minutes, 1, 30, 8), spyCount: clampInt(st.spies, 1, 3, 1), round: 0, score: {} };
  deal(s, ctx);
  return s;
}

const town = (s) => s.participants.filter((id) => !s.spies.includes(id));
const aliveTown = (s, ctx) => town(s).filter((id) => ctx.room.players.get(id));

function add(s, id, pts, why) {
  const r = (s.roundPts[id] = s.roundPts[id] || { pts: 0, why: [] });
  r.pts += pts;
  r.why.push(`${pts > 0 ? '+' : ''}${pts} ${why}`);
  s.score[id] = (s.score[id] || 0) + pts;
}

// kind: caught | innocent | spyRight | spyWrong | reveal
function finish(s, kind, text, ctx) {
  ctx.clearTimer('spy-guess');
  s.phase = 'over';
  const winner = { caught: 'town', spyWrong: 'town', innocent: 'spy', spyRight: 'spy', reveal: null }[kind];
  s.result = { winner, kind, text };
  if (kind === 'spyRight') add(s, s.claim.by, 3, 'угадал локацию');
  if (kind === 'innocent') s.spies.forEach((id) => add(s, id, 2, 'обвинили невиновного'));
  if (winner === 'town') town(s).forEach((id) => add(s, id, 1, kind === 'caught' ? 'шпион пойман' : 'шпион не угадал'));
  if (kind !== 'reveal')
    town(s).forEach((id) => {
      if (s.spies.includes(s.votes[id])) add(s, id, 1, 'голос за шпиона');
    });
}

function checkVotes(s, ctx) {
  if (s.phase !== 'play') return;
  const name = (id) => ctx.room.players.get(id)?.name || '?';
  const alive = s.participants.filter((id) => ctx.room.players.get(id));
  for (const target of alive) {
    const voters = alive.filter((id) => id !== target);
    // нужны голоса всех остальных; при нескольких шпионах сообщники могут не голосовать
    const need = Math.max(1, voters.length - (s.spies.length - 1));
    if (voters.filter((v) => s.votes[v] === target).length >= need) {
      if (s.spies.includes(target)) finish(s, 'caught', `Шпион ${name(target)} пойман!`, ctx);
      else finish(s, 'innocent', `Обвинили невиновного — ${name(target)}. Шпион побеждает.`, ctx);
      return;
    }
  }
}

function checkJudges(s, ctx) {
  if (s.phase !== 'guessing') return;
  const t = aliveTown(s, ctx);
  const yes = t.filter((id) => s.claim.judges[id] === true).length;
  const no = t.filter((id) => s.claim.judges[id] === false).length;
  const half = t.length / 2;
  const n = ctx.room.players.get(s.claim.by)?.name || 'Шпион';
  if (yes > half) finish(s, 'spyRight', `${n} угадал локацию — ${s.location}!`, ctx);
  else if (no > half) finish(s, 'spyWrong', `${n} не угадал. Мы были: ${s.location}.`, ctx);
}

function action(s, pid, msg, ctx) {
  switch (msg.type) {
    case 'vote': {
      if (s.phase === 'guessing') return 'Шпион называет локацию — голосование на паузе';
      if (s.phase !== 'play') return;
      if (!s.participants.includes(pid)) return 'Вы смотрите этот раунд';
      if (msg.target === pid) return 'Нельзя голосовать за себя';
      if (!msg.target || s.votes[pid] === msg.target) delete s.votes[pid];
      else s.votes[pid] = msg.target;
      checkVotes(s, ctx);
      return;
    }
    case 'claim': {
      if (s.phase !== 'play') return;
      if (!s.spies.includes(pid)) return 'Это кнопка шпиона';
      s.phase = 'guessing';
      // Шпион называет локацию вслух — без таймера, мирные решают кнопками
      s.claim = { by: pid, judges: {} };
      return;
    }
    case 'judge': {
      if (s.phase !== 'guessing') return;
      if (!town(s).includes(pid)) return 'Решают мирные игроки';
      s.claim.judges[pid] = !!msg.ok;
      checkJudges(s, ctx);
      return;
    }
    case 'askWho': {
      if (s.phase !== 'play') return;
      if (pid !== s.asker && !ctx.isHost) return 'Сейчас спрашивает другой игрок';
      const t = msg.target;
      if (!alivePart(s, ctx).includes(t) || t === s.asker) return 'Этого игрока спросить нельзя';
      if (t === s.prev && alivePart(s, ctx).length > 2) return 'Нельзя сразу задать вопрос тому, кто спросил вас';
      s.target = s.target === t ? null : t;
      return;
    }
    case 'answered': {
      if (s.phase !== 'play' || !s.target) return;
      if (pid !== s.target && pid !== s.asker && !ctx.isHost) return 'Отвечает другой игрок';
      s.asked[s.target] = (s.asked[s.target] || 0) + 1;
      s.qlog.push({ from: s.asker, to: s.target });
      if (s.qlog.length > 30) s.qlog.shift();
      s.prev = s.asker;
      s.asker = s.target;
      s.target = null;
      return;
    }
    case 'reveal': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase === 'over') return;
      finish(s, 'reveal', 'Хост открыл карты — без очков', ctx);
      return;
    }
    case 'addTime': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'play') return;
      if (s.roundPaused) s.roundLeft += 60000;
      else s.endsAt += 60000;
      s.minutes += 1;
      return;
    }
    case 'pauseRound': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'play') return;
      if (!s.roundPaused) {
        s.roundLeft = Math.max(0, s.endsAt - Date.now());
        s.roundPaused = true;
      } else {
        s.roundPaused = false;
        s.endsAt = Date.now() + s.roundLeft;
      }
      return;
    }
    case 'next': {
      if (!ctx.isHost) return 'Только хост';
      if (ctx.players().length < 3) return 'Нужно минимум 3 игрока';
      ctx.clearTimer('spy-guess');
      deal(s, ctx);
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid) {
  const inGame = s.participants.includes(pid);
  const isSpy = s.spies.includes(pid);
  const over = s.phase === 'over';
  return {
    phase: s.phase,
    round: s.round,
    endsAt: s.roundPaused ? null : s.endsAt,
    paused: !!s.roundPaused,
    pausedLeft: s.roundPaused ? s.roundLeft : null,
    roundMs: s.minutes * 60000,
    inGame,
    isSpy,
    location: over || (inGame && !isSpy) ? s.location : null,
    role: inGame && !isSpy ? s.roles[pid] : null,
    spies: over ? s.spies : null,
    roles: over ? s.roles : null,
    spyCount: s.spies.length,
    participants: s.participants,
    votes: s.votes,
    claim: s.claim ? { by: s.claim.by, judges: s.claim.judges } : null,
    result: s.result,
    roundPts: over ? s.roundPts : null,
    firstAsks: s.firstAsks,
    asker: s.asker,
    target: s.target,
    prev: s.prev,
    asked: s.asked,
    qlog: s.qlog.slice(-8),
    score: s.score,
  };
}

function onLeave(s, pid, ctx) {
  // Вышел или выгнан — больше не участвует в раунде
  const wasSpy = s.spies.includes(pid);
  if (!wasSpy || s.phase === 'over') {
    s.participants = s.participants.filter((x) => x !== pid);
    if (s.roles) delete s.roles[pid];
  }
  delete s.score[pid];
  if (s.asked) delete s.asked[pid];
  if (s.claim) delete s.claim.judges[pid];
  delete s.votes[pid];
  if (s.target === pid) s.target = null;
  if (s.asker === pid) {
    const rest = alivePart(s, ctx).filter((id) => id !== pid);
    s.asker = rest.length ? pick(rest) : null;
    s.target = null;
  }
  for (const k of Object.keys(s.votes)) if (s.votes[k] === pid) delete s.votes[k];
  if (s.phase !== 'over' && s.spies.includes(pid)) {
    s.phase = 'over';
    s.result = { winner: null, kind: 'reveal', text: 'Шпион покинул игру' };
    ctx.clearTimer('spy-guess');
  } else {
    checkVotes(s, ctx);
    checkJudges(s, ctx);
  }
}

const isOver = (s) => s.phase === 'over';
const results = (s) => Object.fromEntries(s.participants.map((id) => [id, s.roundPts[id]?.pts || 0]));

function pause(s) {
  s._paused = Date.now();
}
function resume(s, ctx) {
  if (!s._paused) return;
  const gap = Date.now() - s._paused;
  s._paused = null;
  if (s.endsAt) s.endsAt += gap; // таймер раунда не тикает, пока игра на паузе
}

// Для номинаций марафона
function stats(s) {
  const detector = {};
  const spy = {};
  if (s.phase === 'over' && s.result && s.result.kind !== 'reveal') {
    for (const id of town(s)) if (s.spies.includes(s.votes[id])) detector[id] = 1;
    if (s.result.winner === 'spy') for (const id of s.spies) spy[id] = 1;
  }
  return { detector, spy };
}

module.exports = { meta, create, action, view, onLeave, isOver, results, pause, resume, stats };
