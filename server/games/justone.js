const { WORDS } = require('../words');
const { shuffle, Deck, norm, clampInt, customWords } = require('../util');

const meta = {
  title: 'Намёк понял',
  emoji: '💡',
  players: '3–20',
  short: 'Все пишут по одной подсказке, одинаковые сгорают. Угадал — и выбери лучшую подсказку.',
  rules: [
    'Один игрок угадывает, остальные видят загаданное слово и пишут по одной подсказке из одного слова. Подсказка не должна быть однокоренной, переводом или созвучием.',
    'Затем подсказчики видят все подсказки и вычёркивают одинаковые и однокоренные (совпадения отмечаются автоматически) — угадывающий их не увидит. Так что слишком очевидную ассоциацию писать рискованно.',
    'Угадывающий видит оставшиеся подсказки анонимно и в случайном порядке и пишет ответ. Если ответ не совпал точь-в-точь (синоним, опечатка, другая форма слова), подсказчики могут нажать «Засчитать» — когда согласны все, ответ засчитывается. Если угадал — отмечает самую полезную подсказку (авторов он не видит, чтобы выбор был честным).',
    'Очки, если слово угадано: угадывающему +2; каждому, чья подсказка не сгорела, +1; автору лучшей подсказки — ещё +3. Если не угадано или пропуск — очков нет ни у кого.',
    'Угадывающий меняется каждый раунд. Игра заканчивается в конце раунда, когда кто-то набрал нужное число очков (задаёт хост).',
  ],
  restartActions: ['restart'],
  settings: [
    { key: 'target', label: 'Очков до победы', type: 'select', options: [8, 10, 15, 20, 25, 30], default: 15 },
    { key: 'customWords', label: 'Свои слова (через запятую, необязательно)', type: 'textarea' },
  ],
};

function create(ctx, st) {
  const ids = shuffle(ctx.players().map((p) => p.id));
  if (ids.length < 3) return 'Для «Намёк понял» нужно минимум 3 игрока';
  const s = {
    order: ids,
    g: -1,
    target: clampInt(st.target, 3, 100, 15),
    points: Object.fromEntries(ids.map((id) => [id, 0])),
    deck: new Deck([...customWords(st.customWords), ...WORDS]),
    history: [],
    round: 0,
  };
  nextRound(s, ctx);
  return s;
}

const alive = (s, ctx) => s.order.filter((id) => ctx.room.players.get(id));

function nextRound(s, ctx) {
  for (let k = 0; k < s.order.length; k++) {
    s.g = (s.g + 1) % s.order.length;
    if (ctx.room.players.get(s.order[s.g])) break;
  }
  s.round++;
  s.guesser = s.order[s.g];
  s.word = s.deck.draw();
  s.clues = {}; // pid -> {text, removed}
  s.phase = 'clues'; // clues | filter | guess | result | over
  s.guess = null;
  s.correct = null;
  s.heart = null;
  s.anon = null;
  s.accept = {}; // голоса подсказчиков «засчитать» неточный ответ
  s.accepted = false;
  s.helpers = alive(s, ctx).filter((id) => id !== s.guesser);
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

const helpersOnline = (s, ctx) =>
  s.helpers.filter((id) => {
    const p = ctx.room.players.get(id);
    return p && p.connected !== false;
  });
function checkAccept(s, ctx) {
  if (s.phase !== 'result' || !s.guess || s.correct) return;
  const need = helpersOnline(s, ctx);
  if (need.length && need.every((id) => s.accept[id])) {
    s.correct = true;
    s.accepted = true;
  }
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
    if (s.heart && s.clues[s.heart] && !s.clues[s.heart].removed) add(s.heart, 3, 'лучшая подсказка');
  }
  return got;
}

function action(s, pid, msg, ctx) {
  const isHelper = s.helpers?.includes(pid);
  switch (msg.type) {
    case 'clue': {
      if (s.phase !== 'clues') return 'Подсказки уже собраны';
      if (!isHelper) return 'Вы угадываете в этом раунде';
      const text = String(msg.text || '').trim().slice(0, 30);
      if (!text) return 'Пустая подсказка';
      s.clues[pid] = { text, removed: false };
      const need = s.helpers.filter((id) => ctx.room.players.get(id));
      if (need.every((id) => s.clues[id])) {
        autoDupes(s);
        s.phase = 'filter';
      }
      return;
    }
    case 'forceFilter': {
      if (!ctx.isHost) return 'Только хост';
      if (s.phase !== 'clues') return;
      autoDupes(s);
      s.phase = 'filter';
      return;
    }
    case 'toggle': {
      if (s.phase !== 'filter' || !isHelper) return;
      const c = s.clues[msg.pid];
      if (c) c.removed = !c.removed;
      return;
    }
    case 'filterDone': {
      if (s.phase !== 'filter') return;
      if (!isHelper && !ctx.isHost) return;
      // Угадывающий видит подсказки анонимно и в случайном порядке — чтобы выбирать лучшую честно
      s.anon = shuffle(Object.keys(s.clues));
      s.phase = 'guess';
      return;
    }
    case 'guess': {
      if (s.phase !== 'guess' || pid !== s.guesser) return;
      const g = String(msg.text || '').trim().slice(0, 40);
      s.guess = g || null;
      s.correct = g ? norm(g) === norm(s.word) : null; // null = пропуск
      s.accept = {};
      s.accepted = false;
      s.phase = 'result';
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
    // Ответ не совпал точь-в-точь (синоним, опечатка, другая форма) — подсказчики могут засчитать.
    // Когда «за» проголосовали все подсказчики в сети — ответ засчитан.
    case 'override':
    case 'accept': {
      if (s.phase !== 'result' || !isHelper) return;
      if (!s.guess || (s.correct && !s.accepted)) return 'Ответ и так верный';
      if (s.accepted) return 'Ответ уже засчитан';
      if (s.accept[pid]) delete s.accept[pid];
      else s.accept[pid] = true;
      checkAccept(s, ctx);
      return;
    }
    case 'next': {
      if (s.phase !== 'result') return;
      if (!isHelper && pid !== s.guesser && !ctx.isHost) return;
      if (pid === s.guesser && !ctx.isHost && s.guess && !s.correct) return 'Подсказчики решают, засчитать ли ответ';
      if (s.correct && !s.heart && pid !== s.guesser && !ctx.isHost) return 'Ждём, пока угадывающий отметит лучшую подсказку';
      const got = award(s);
      s.history.push({ word: s.word, guesser: s.guesser, guess: s.guess, correct: s.correct, heart: s.heart, got });
      s.lastRound = { word: s.word, got };
      const best = Math.max(...Object.values(s.points));
      if (best >= s.target) {
        s.phase = 'over';
        s.winners = Object.keys(s.points).filter((id) => s.points[id] === best);
        return;
      }
      nextRound(s, ctx);
      return;
    }
    case 'restart': {
      if (!ctx.isHost) return 'Только хост';
      for (const id of Object.keys(s.points)) s.points[id] = 0;
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
    guess: s.guess,
    correct: s.correct,
    accept: Object.keys(s.accept || {}),
    accepted: !!s.accepted,
    heart: isGuesser && s.phase !== 'over' ? (s.heart ? (s.anon || []).indexOf(s.heart) : null) : s.heart,
    points: s.points,
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
    nextRound(s, ctx);
    return;
  }
  s.order = s.order.filter((x) => x !== pid);
  s.helpers = s.helpers.filter((x) => x !== pid);
  delete s.clues[pid];
  if (s.accept) delete s.accept[pid];
  checkAccept(s, ctx);
  if (s.phase === 'clues' && s.helpers.length && s.helpers.every((id) => s.clues[id])) {
    autoDupes(s);
    s.phase = 'filter';
  }
}

const isOver = (s) => s.phase === 'over';
const results = (s) => ({ ...s.points });

// Кто-то из подсказчиков отвалился — остальных может уже хватать для «засчитать»
const onPresence = (s, ctx) => checkAccept(s, ctx);

module.exports = { meta, create, action, view, onLeave, isOver, results, onPresence };
