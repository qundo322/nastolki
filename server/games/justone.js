const { WORDS } = require('../words');
const { shuffle, Deck, norm, clampInt, customWords } = require('../util');

// Время фаз
const CLUE_MS = 60000; // написать подсказку
const FILTER_MS = 30000; // вычеркнуть совпадения
const RESULT_MS = 30000; // выбрать лучшую подсказку / решить «засчитать»

const meta = {
  title: 'Намёк понял',
  emoji: '💡',
  players: '3–20',
  short: 'Все пишут по одной подсказке, одинаковые сгорают. Угадал — и выбери лучшую подсказку.',
  rules: [
    'Один игрок угадывает, остальные видят загаданное слово и за минуту пишут по одной подсказке — одно слово (буквы и цифры, можно через дефис). Подсказку нельзя заменить после отправки.',
    'Затем за 30 секунд подсказчики вычёркивают одинаковые и однокоренные подсказки (совпадения отмечаются автоматически). Подсказки уходят угадывающему, когда «Показать» нажмут все подсказчики или выйдет время.',
    'Угадывающий видит оставшиеся подсказки анонимно и пишет ответ. Угадал — за 30 секунд отмечает лучшую подсказку сердечком.',
    'Ответ не совпал точь-в-точь? Подсказчики решают: «Засчитать» или «Не засчитывать» — решение принимается, когда так нажмут все. За 30 секунд не договорились — не засчитано.',
    'Очки, если слово угадано: угадывающему +2; каждому, чья подсказка не сгорела, +1; автору лучшей подсказки — ещё +3.',
    'Угадывающий меняется каждый раунд. Игра заканчивается в конце раунда, когда кто-то набрал нужное число очков (задаёт хост).',
  ],
  restartActions: ['restart'],
  settings: [
    { key: 'target', label: 'Очков до победы', type: 'select', options: [8, 10, 15, 20, 25, 30], default: 15 },
    { key: 'customWords', label: 'Свои слова (через запятую, необязательно)', type: 'textarea' },
  ],
};

// Одно слово: буквы и цифры, части можно соединить дефисом
const ONE_WORD = /^[\p{L}\d]+(?:-[\p{L}\d]+)*$/u;
const cleanWord = (t) => String(t || '').trim().slice(0, 30);

function create(ctx, st) {
  const ids = shuffle(ctx.players().map((p) => p.id));
  if (ids.length < 3) return 'Для «Намёк понял» нужно минимум 3 игрока';
  const s = {
    order: ids,
    g: -1,
    target: clampInt(st.target, 3, 100, 15),
    points: Object.fromEntries(ids.map((id) => [id, 0])),
    hearts: {},
    deck: new Deck([...customWords(st.customWords).filter((w) => !/\s/.test(w)), ...WORDS]),
    history: [],
    round: 0,
  };
  nextRound(s, ctx);
  return s;
}

const alive = (s, ctx) => s.order.filter((id) => ctx.room.players.get(id));
const online = (s, ctx, ids) => ids.filter((id) => ctx.room.players.get(id) && ctx.room.players.get(id).connected !== false);

// ---- таймер фазы ----
function setPhase(s, ctx, phase, ms) {
  s.phase = phase;
  ctx.clearTimer('jo');
  if (ms) {
    s.endsAt = Date.now() + ms;
    s.phaseMs = ms;
    ctx.setTimer('jo', ms, () => onTimeout(s, ctx));
  } else {
    s.endsAt = null;
    s.phaseMs = null;
  }
}
function onTimeout(s, ctx) {
  if (s.phase === 'clues') toFilter(s, ctx);
  else if (s.phase === 'filter') toGuess(s, ctx);
  else if (s.phase === 'result') finishRound(s, ctx);
}

function nextRound(s, ctx) {
  for (let k = 0; k < s.order.length; k++) {
    s.g = (s.g + 1) % s.order.length;
    if (ctx.room.players.get(s.order[s.g])) break;
  }
  s.round++;
  s.guesser = s.order[s.g];
  s.word = s.deck.draw();
  s.clues = {}; // pid -> {text, removed}
  s.guess = null;
  s.correct = null;
  s.heart = null;
  s.anon = null;
  s.accept = {}; // «засчитать» неточный ответ
  s.reject = {}; // «не засчитывать»
  s.accepted = false;
  s.show = {}; // кто нажал «Показать угадывающему»
  s.helpers = alive(s, ctx).filter((id) => id !== s.guesser);
  setPhase(s, ctx, 'clues', CLUE_MS); // clues | filter | guess | result | over
}

function autoDupes(s) {
  const groups = {};
  for (const [id, c] of Object.entries(s.clues)) {
    const k = norm(c.text);
    const key = k.length > 4 ? k.slice(0, 5) : k; // грубая проверка на однокоренные
    (groups[key] = groups[key] || []).push(id);
  }
  for (const ids of Object.values(groups)) if (ids.length > 1) ids.forEach((id) => (s.clues[id].removed = true));
  for (const c of Object.values(s.clues)) if (norm(c.text) === norm(s.word)) c.removed = true;
}
function toFilter(s, ctx) {
  autoDupes(s);
  s.show = {};
  setPhase(s, ctx, 'filter', FILTER_MS);
}
function toGuess(s, ctx) {
  // Угадывающий видит подсказки анонимно и в случайном порядке — чтобы выбирать лучшую честно
  s.anon = shuffle(Object.keys(s.clues));
  setPhase(s, ctx, 'guess', 0);
}

// Подсчёт очков раунда
function award(s) {
  const got = {};
  const add = (id, n, why) => {
    got[id] = got[id] || { pts: 0, why: [] };
    got[id].pts += n;
    got[id].why.push(`+${n} ${why}`);
    s.points[id] = (s.points[id] || 0) + n;
  };
  if (s.correct) {
    add(s.guesser, 2, 'угадал');
    for (const [id, c] of Object.entries(s.clues)) if (!c.removed) add(id, 1, 'подсказка дошла');
    if (s.heart && s.clues[s.heart] && !s.clues[s.heart].removed) {
      add(s.heart, 3, 'лучшая подсказка');
      s.hearts[s.heart] = (s.hearts[s.heart] || 0) + 1;
    }
  }
  return got;
}
function finishRound(s, ctx) {
  if (s.phase !== 'result') return;
  const got = award(s);
  s.history.push({ word: s.word, guesser: s.guesser, guess: s.guess, correct: s.correct, accepted: s.accepted, heart: s.correct ? s.heart : null, got });
  s.lastRound = { word: s.word, got };
  const best = Math.max(...Object.values(s.points));
  if (best >= s.target) {
    setPhase(s, ctx, 'over', 0);
    s.winners = Object.keys(s.points).filter((id) => s.points[id] === best);
    return;
  }
  nextRound(s, ctx);
}

// Все подсказчики в сети согласны
const allOf = (s, ctx, votes) => {
  const need = online(s, ctx, s.helpers);
  return need.length > 0 && need.every((id) => votes[id]);
};
function checkVotes(s, ctx) {
  if (s.phase === 'clues' && s.helpers.length && online(s, ctx, s.helpers).every((id) => s.clues[id])) toFilter(s, ctx);
  else if (s.phase === 'filter' && allOf(s, ctx, s.show)) toGuess(s, ctx);
  else if (s.phase === 'result' && s.guess && !s.correct) {
    if (allOf(s, ctx, s.accept)) {
      s.correct = true;
      s.accepted = true;
      setPhase(s, ctx, 'result', RESULT_MS); // теперь — время выбрать лучшую подсказку
    } else if (allOf(s, ctx, s.reject)) finishRound(s, ctx);
  }
}

function action(s, pid, msg, ctx) {
  const isHelper = s.helpers?.includes(pid);
  switch (msg.type) {
    case 'clue': {
      if (s.phase !== 'clues') return 'Подсказки уже собраны';
      if (!isHelper) return 'Вы угадываете в этом раунде';
      if (s.clues[pid]) return 'Подсказка уже отправлена';
      const text = cleanWord(msg.text);
      if (!text) return 'Пустая подсказка';
      if (!ONE_WORD.test(text)) return 'Только одно слово: буквы и цифры, без пробелов и символов (дефис можно)';
      s.clues[pid] = { text, removed: false };
      checkVotes(s, ctx);
      return;
    }
    case 'forceFilter': {
      // Хост может не ждать: подсказки → вычёркивание → показать угадывающему
      if (!ctx.isHost) return 'Только хост';
      if (s.phase === 'clues') toFilter(s, ctx);
      else if (s.phase === 'filter') toGuess(s, ctx);
      return;
    }
    case 'addTime': {
      if (!ctx.isHost) return 'Только хост';
      if (!s.endsAt) return;
      const left = s.endsAt - Date.now() + 30000;
      const ph = s.phase;
      setPhase(s, ctx, ph, left);
      s.phaseMs = Math.max(left, s.phaseMs || 0);
      return;
    }
    case 'newWord': {
      // Другое слово тому же угадывающему, подсказки пишутся заново
      if (!ctx.isHost) return 'Только хост';
      if (!['clues', 'filter'].includes(s.phase)) return 'Слово можно сменить, пока пишут подсказки';
      s.word = s.deck.draw();
      s.clues = {};
      s.show = {};
      setPhase(s, ctx, 'clues', CLUE_MS);
      return;
    }
    case 'skipRound': {
      // Раунд без очков — угадывать будет следующий
      if (!ctx.isHost) return 'Только хост';
      if (s.phase === 'over') return;
      nextRound(s, ctx);
      return;
    }
    case 'toggle': {
      if (s.phase !== 'filter' || !isHelper) return;
      const c = s.clues[msg.pid];
      if (c) c.removed = !c.removed;
      return;
    }
    case 'filterDone': {
      // «Показать угадывающему» — нужно нажать всем подсказчикам
      if (s.phase !== 'filter') return;
      if (!isHelper) return 'Решают подсказчики';
      if (s.show[pid]) delete s.show[pid];
      else s.show[pid] = true;
      checkVotes(s, ctx);
      return;
    }
    case 'guess': {
      if (s.phase !== 'guess' || pid !== s.guesser) return;
      const g = cleanWord(msg.text);
      if (g && !ONE_WORD.test(g)) return 'Ответ — одно слово: буквы и цифры, без символов (дефис можно)';
      s.guess = g || null;
      s.correct = g ? norm(g) === norm(s.word) : null; // null = пропуск
      s.accept = {};
      s.reject = {};
      s.accepted = false;
      setPhase(s, ctx, 'result', s.correct === null ? 0 : RESULT_MS);
      return;
    }
    case 'heart': {
      if (s.phase !== 'result' || pid !== s.guesser) return 'Лучшую подсказку выбирает угадывающий';
      if (!s.correct) return 'Сердечко ставится, только если слово угадано';
      const target = msg.key != null ? (s.anon || [])[msg.key] : msg.pid;
      const c = s.clues[target];
      if (!c || c.removed) return;
      s.heart = s.heart === target ? null : target;
      return;
    }
    case 'override':
    case 'accept':
    case 'reject': {
      // Неточный ответ: «засчитать» / «не засчитывать» — решение, когда так нажали все подсказчики
      if (s.phase !== 'result' || !isHelper) return;
      if (!s.guess || s.correct) return s.accepted ? 'Ответ уже засчитан' : 'Ответ и так верный';
      const yes = msg.type !== 'reject';
      const mine = yes ? s.accept : s.reject;
      const other = yes ? s.reject : s.accept;
      delete other[pid];
      if (mine[pid]) delete mine[pid];
      else mine[pid] = true;
      checkVotes(s, ctx);
      return;
    }
    case 'next': {
      if (s.phase !== 'result') return;
      if (s.guess && !s.correct && !ctx.isHost) return 'Подсказчики решают, засчитать ли ответ';
      if (s.correct && pid !== s.guesser && !ctx.isHost) return 'Ждём, пока угадывающий отметит лучшую подсказку';
      if (s.correct === null && !isHelper && pid !== s.guesser && !ctx.isHost) return;
      finishRound(s, ctx);
      return;
    }
    case 'restart': {
      if (!ctx.isHost) return 'Только хост';
      for (const id of Object.keys(s.points)) s.points[id] = 0;
      s.hearts = {};
      s.history = [];
      s.lastRound = null;
      s.round = 0;
      nextRound(s, ctx);
      return;
    }
    case 'addMe': {
      if (s.order.includes(pid)) return;
      s.order.push(pid);
      s.points[pid] = 0;
      if (s.phase === 'clues') s.helpers.push(pid);
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid) {
  const isGuesser = pid === s.guesser;
  const showClues = s.phase === 'filter' ? !isGuesser : s.phase === 'guess' || s.phase === 'result';
  return {
    phase: s.phase,
    round: s.round,
    guesser: s.guesser,
    isGuesser,
    inGame: s.order.includes(pid),
    helpers: s.helpers,
    endsAt: s.endsAt,
    phaseMs: s.phaseMs,
    word: !isGuesser || s.phase === 'result' || s.phase === 'over' ? s.word : null,
    submitted: Object.keys(s.clues || {}),
    myClue: s.clues?.[pid]?.text || null,
    clues: !showClues
      ? []
      : isGuesser
        ? (s.anon || Object.keys(s.clues))
            .map((id, key) => ({ key, text: s.clues[id]?.text, removed: s.clues[id]?.removed }))
            .filter((c) => c.text && !(s.phase === 'guess' && c.removed))
        : Object.entries(s.clues).map(([id, c]) => ({ pid: id, key: (s.anon || []).indexOf(id), text: c.text, removed: c.removed })),
    show: Object.keys(s.show || {}),
    guess: s.guess,
    correct: s.correct,
    accept: Object.keys(s.accept || {}),
    reject: Object.keys(s.reject || {}),
    accepted: !!s.accepted,
    heart: isGuesser && s.phase !== 'over' ? (s.heart ? (s.anon || []).indexOf(s.heart) : null) : s.heart,
    points: s.points,
    hearts: s.hearts,
    target: s.target,
    winners: s.winners || null,
    lastRound: s.lastRound || null,
    history: s.history.slice(-15),
  };
}

function onLeave(s, pid, ctx) {
  if (s.phase === 'over') return;
  if (pid === s.guesser) {
    s.g = s.order.indexOf(pid) - 1;
    s.order = s.order.filter((x) => x !== pid);
    delete s.points[pid];
    delete s.hearts[pid];
    nextRound(s, ctx);
    return;
  }
  s.order = s.order.filter((x) => x !== pid);
  s.helpers = s.helpers.filter((x) => x !== pid);
  delete s.clues[pid];
  delete s.points[pid];
  delete s.hearts[pid];
  for (const v of [s.accept, s.reject, s.show]) if (v) delete v[pid];
  checkVotes(s, ctx);
}

// Пауза игры (лобби) — таймер фазы замирает
function pause(s, ctx) {
  if (!s.endsAt) return;
  s._left = Math.max(0, s.endsAt - Date.now());
  ctx.clearTimer('jo');
}
function resume(s, ctx) {
  if (s._left == null) return;
  s.endsAt = Date.now() + s._left;
  ctx.setTimer('jo', s._left, () => onTimeout(s, ctx));
  s._left = null;
}
// Кто-то отвалился — остальных может уже хватать для решения
const onPresence = (s, ctx) => checkVotes(s, ctx);

const isOver = (s) => s.phase === 'over';
const results = (s) => ({ ...s.points });
// Для номинаций марафона: сердечки за лучшую подсказку
const stats = (s) => ({ hints: { ...s.hearts } });

module.exports = { meta, create, action, view, onLeave, isOver, results, onPresence, stats, pause, resume };
