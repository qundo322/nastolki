const { WORDS } = require('../words');
const { shuffle, customWords } = require('../util');

const REVEAL_DELAY = 2000; // все агенты на одной карточке → через 2 с она открывается
const FIRST_CLUE_MS = 120000; // самый первый ход капитана
const CLUE_MS = 60000; // капитан думает над подсказкой
const GUESS_MS = 60000; // команда отгадывает
const BONUS_MS = 15000; // за каждое верно открытое слово
const EDIT_MS = 15000; // капитан может поправить подсказку
const MAX_SLOTS = 9;

const meta = {
  title: 'Коднеймс',
  emoji: '🕵️',
  players: '4–20',
  short: 'Капитаны дают подсказку из одного слова, команда ищет свои карточки на поле 5×5.',
  rules: [
    'Две команды — красные и синие. У каждой есть капитан, который видит цвета всех карточек.',
    'В свой ход капитан пишет подсказку — одно слово — и указывает, к каким карточкам она относится. По умолчанию это одно слово с силой 1. Кнопка «+» добавляет ещё одно. Силу каждого можно менять от 0 до 1 (до сотых): 1 — точно подходит, 0.73 — подходит на 73%. Пример: «Яблоко (1) (1) (0.73)».',
    'В течение 15 секунд после отправки капитан может исправить подсказку, если ошибся.',
    'Все подсказки остаются в панелях команд. Капитан может зачеркнуть любое число в своих подсказках — например, когда команда отгадала это слово или когда его лучше забыть.',
    'Время: на самый первый ход капитану даётся 2 минуты, дальше — 1 минута. Команде на отгадывание — 1 минута, за каждое верно открытое слово +15 секунд. Если капитан не уложился, его время не сгорает: дальше он думает за счёт минуты команды на отгадывание — сколько осталось, столько и будет на угадывание. Время команды вышло — ход переходит соперникам.',
    'Агенты голосуют за карточку кликом (клик ещё раз — снять голос). На карточке видны аватары тех, кто за неё проголосовал. Когда все агенты ходящей команды выбрали одну карточку, она открывается через 2 секунды; если кто-то передумал — отсчёт отменяется.',
    'Своя карточка — можно продолжать или нажать «Передать ход». Нейтральная или чужая — ход переходит соперникам. Чёрная карточка (убийца) — мгновенное поражение.',
    'Побеждает команда, первой открывшая все свои карточки. Начинающая команда ищет 9 слов, вторая — 8.',
    'Перед каждой партией все распределяются по командам и ролям и нажимают зелёную кнопку «Готов». Когда готовы все — партия начинается. Во время партии менять команду нельзя — только после её окончания (тогда же можно уступить место капитана).',
    'Внутри партии очков нет — побеждает команда. Очки в марафоне: каждый игрок победившей команды занимает 1-е место (+3), проигравшие — 0.',
  ],
  restartActions: ['newBoard'],
  settings: [
    { key: 'customWords', label: 'Свои слова (через запятую, необязательно)', type: 'textarea' },
    { key: 'onlyCustom', label: 'Играть только своими словами', type: 'checkbox' },
  ],
};

const TN = { red: 'Красные', blue: 'Синие' };
const enemy = (t) => (t === 'red' ? 'blue' : 'red');
const left = (s, color) => s.cards.filter((c) => c.color === color && !c.revealed).length;

// ---------- таймер хода ----------
function startClock(s, ctx, ms) {
  ctx.clearTimer('cn-clock');
  s.clock = { endsAt: Date.now() + ms, total: ms, paused: false, left: ms, auto: false };
  ctx.setTimer('cn-clock', ms, () => onTimeout(s, ctx));
}
function stopClock(s, ctx) {
  ctx.clearTimer('cn-clock');
  s.clock = null;
}
function pauseClock(s, ctx) {
  const c = s.clock;
  if (!c || c.paused) return false;
  c.left = Math.max(0, c.endsAt - Date.now());
  c.paused = true;
  ctx.clearTimer('cn-clock');
  return true;
}
function resumeClock(s, ctx) {
  const c = s.clock;
  if (!c || !c.paused) return;
  c.paused = false;
  c.auto = false;
  c.endsAt = Date.now() + c.left;
  ctx.setTimer('cn-clock', c.left, () => onTimeout(s, ctx));
}
function addClock(s, ctx, ms) {
  const c = s.clock;
  if (!c) return;
  if (c.paused) {
    c.left += ms;
    c.total = Math.max(c.total, c.left);
    return;
  }
  c.endsAt += ms;
  c.total = Math.max(c.total, c.endsAt - Date.now());
  ctx.setTimer('cn-clock', c.endsAt - Date.now(), () => onTimeout(s, ctx));
}
function onTimeout(s, ctx) {
  if (s.winner) return;
  // Капитан не уложился — дальше он думает за счёт времени команды на отгадывание
  if (s.step === 'clue' && !s.clock?.over) {
    startClock(s, ctx, GUESS_MS);
    s.clock.over = true;
    s.log.push({ kind: 'overtime', team: s.turn, by: TN[s.turn] });
    return;
  }
  s.log.push({ kind: 'timeout', team: s.turn, by: TN[s.turn] });
  passTurn(s, ctx);
}
const clueTime = (s) => (s.firstClue ? FIRST_CLUE_MS : CLUE_MS);

// ---------- доска ----------
function newBoard(s, ctx) {
  const pool = s.customPool.length >= 25 && s.onlyCustom ? s.customPool : [...s.customPool, ...WORDS];
  const words = shuffle(pool).slice(0, 25);
  const start = Math.random() < 0.5 ? 'red' : 'blue';
  const other = enemy(start);
  const colors = shuffle([...Array(9).fill(start), ...Array(8).fill(other), ...Array(7).fill('neutral'), 'assassin']);
  s.cards = words.map((w, i) => ({ w, color: colors[i], revealed: false, marks: [] }));
  s.start = start;
  s.turn = start;
  s.step = 'clue'; // clue | guess
  s.clue = null;
  s.clues = [];
  s.log = [];
  s.winner = null;
  s.reason = null;
  s.pending = null;
  s.firstClue = true;
  s.ready = {};
  s.turnAt = Date.now();
  // Статистика партии для итогов
  s.st = { right: {}, wrong: {}, assassin: [], capHits: {}, opened: {}, lead: {}, flips: {}, think: {}, gifts: { red: 0, blue: 0 }, neutral: { red: 0, blue: 0 }, fast: null, startAt: Date.now(), turns: 1 };
  ctx.clearTimer('cn-reveal');
  startClock(s, ctx, FIRST_CLUE_MS);
}

// Подготовка: доска скрыта, таймера нет, все распределяются и жмут «Готов»
function enterSetup(s, ctx) {
  ctx.clearTimer('cn-clock');
  ctx.clearTimer('cn-reveal');
  s.clock = null;
  s.pending = null;
  s.step = 'setup';
  s.ready = {};
}
// Чего не хватает, чтобы начать
// Итоги партии: лучшая подсказка, снайпер, мимокрокодил, кто открыл убийцу
function summary(s) {
  const st = s.st;
  if (!st) return null;
  const top = (o) => {
    const e = Object.entries(o).sort((a, b) => b[1] - a[1]);
    return e.length && e[0][1] > 0 ? { pid: e[0][0], n: e[0][1] } : null;
  };
  const best = s.clues.filter((c) => c.hits).sort((a, b) => b.hits - a.hits || b.id - a.id)[0];
  return {
    bestClue: best ? { text: clueText(best), by: best.by, team: best.team, hits: best.hits } : null,
    sniper: top(st.right),
    miss: top(st.wrong),
    assassin: st.assassin,
    clues: s.clues.length,
    lead: top(st.lead || {}),
    waverer: top(st.flips || {}),
    // Дольше всех думал / быстрее всех — по среднему времени капитана на подсказку
    slowCap: (() => {
      const e = Object.entries(st.think || {}).sort((a, b) => b[1].max - a[1].max)[0];
      return e ? { pid: e[0], ms: e[1].max } : null;
    })(),
    fastCap: (() => {
      const e = Object.entries(st.think || {}).map(([id, t]) => [id, t.sum / t.n]).sort((a, b) => a[1] - b[1])[0];
      return e && Object.keys(st.think).length > 1 ? { pid: e[0], ms: Math.round(e[1]) } : null;
    })(),
    fast: st.fast,
    bold: (() => {
      const c = s.clues.slice().sort((a, b) => b.slots.length - a.slots.length || (b.hits || 0) - (a.hits || 0))[0];
      return c && c.slots.length >= 3 ? { text: clueText(c), by: c.by, n: c.slots.length, hits: c.hits || 0 } : null;
    })(),
    gifts: st.gifts,
    neutral: st.neutral,
    duration: (st.endAt || Date.now()) - (st.startAt || Date.now()),
    turns: st.turns || 1,
  };
}
// Для номинаций марафона
function stats(s) {
  const st = s.st || {};
  return { captain: { ...(st.capHits || {}) }, sniper: { ...(st.right || {}) } };
}

function setupNeeds(s, ctx) {
  const need = [];
  for (const t of ['red', 'blue']) {
    const cap = s.captain[t];
    if (!cap || !ctx.room.players.get(cap)?.connected) need.push(`капитан ${t === 'red' ? 'красных' : 'синих'}`);
    const ag = Object.keys(s.team).filter((id) => s.team[id] === t && id !== cap && ctx.room.players.get(id)?.connected);
    if (!ag.length) need.push(`агент ${t === 'red' ? 'красных' : 'синих'}`);
  }
  return need;
}
const readyPool = (s, ctx) => Object.keys(s.team).filter((id) => ctx.room.players.get(id)?.connected);
function checkReady(s, ctx) {
  if (s.step !== 'setup' && !s.winner) return;
  const pool = readyPool(s, ctx);
  if (!pool.length || setupNeeds(s, ctx).length) return;
  if (pool.every((id) => s.ready[id])) newBoard(s, ctx);
}

function create(ctx, settings) {
  const s = {
    customPool: customWords(settings.customWords),
    onlyCustom: !!settings.onlyCustom,
    team: {}, // pid -> red|blue (без команды — зритель)
    captain: { red: null, blue: null },
  };
  shuffle(ctx.players().map((p) => p.id)).forEach((pid, i) => (s.team[pid] = i % 2 ? 'blue' : 'red'));
  newBoard(s, ctx);
  enterSetup(s, ctx);
  return s;
}

// Агенты ходящей команды, которые сейчас онлайн
function agents(s, ctx) {
  return Object.keys(s.team).filter((id) => s.team[id] === s.turn && s.captain[s.turn] !== id && ctx.room.players.get(id)?.connected);
}

function cancelPending(s, ctx) {
  if (s.pending) {
    s.pending = null;
    ctx.clearTimer('cn-reveal');
  }
}

function passTurn(s, ctx) {
  cancelPending(s, ctx);
  s.cards.forEach((c) => (c.marks = []));
  s.turn = enemy(s.turn);
  s.step = 'clue';
  s.clue = null;
  s.turnAt = Date.now();
  s.firstClue = false; // 2 минуты — только на самый первый ход партии
  if (s.st) s.st.turns++;
  startClock(s, ctx, clueTime(s));
}

function reveal(s, i, ctx) {
  const c = s.cards[i];
  if (!c || c.revealed) return;
  s.pending = null;
  c.revealed = true;
  // Кто голосовал за открытую карточку
  const st = s.st || (s.st = { right: {}, wrong: {}, assassin: [], capHits: {}, opened: {}, lead: {}, flips: {}, think: {}, gifts: { red: 0, blue: 0 }, neutral: { red: 0, blue: 0 }, fast: null, startAt: Date.now(), turns: 1 });
  const own = c.color === s.turn;
  for (const id of c.marks) {
    const bag = own ? st.right : st.wrong;
    bag[id] = (bag[id] || 0) + 1;
  }
  if (c.color === 'assassin') st.assassin = [...c.marks];
  // Заводила: первым проголосовал за свою карточку
  if (own && c.first) st.lead[c.first] = (st.lead[c.first] || 0) + 1;
  if (c.color === enemy(s.turn)) st.gifts[s.turn]++;
  if (c.color === 'neutral') st.neutral[s.turn]++;
  // Самое быстрое попадание после подсказки
  if (own && s.clue && s.clue.at && !s.clue.firstHit) {
    s.clue.firstHit = true;
    const ms = Date.now() - s.clue.at;
    if (!st.fast || ms < st.fast.ms) st.fast = { ms, team: s.turn, word: c.w, by: c.first || null };
  }
  if (own && s.clue) {
    s.clue.hits = (s.clue.hits || 0) + 1;
    const cap = s.clue.by;
    st.capHits[cap] = (st.capHits[cap] || 0) + 1;
  }
  s.cards.forEach((x) => (x.marks = []));
  s.log.push({ kind: 'reveal', team: s.turn, text: c.w, color: c.color, by: TN[s.turn] });
  if (c.color === 'assassin') {
    s.winner = enemy(s.turn);
    s.reason = 'assassin';
  } else if (!left(s, 'red')) s.winner = 'red';
  else if (!left(s, 'blue')) s.winner = 'blue';
  if (s.winner) {
    st.endAt = Date.now();
    s.ready = {}; // после партии — снова распределяемся и жмём «Готов»
    return stopClock(s, ctx);
  }
  if (c.color !== s.turn) passTurn(s, ctx);
  else addClock(s, ctx, BONUS_MS);
}

// Все агенты на одной карточке → запускаем отсчёт, иначе отменяем
function checkConsensus(s, ctx) {
  if (s.winner || s.step !== 'guess') return cancelPending(s, ctx);
  const ag = agents(s, ctx);
  const card = s.cards.findIndex((c) => !c.revealed && c.marks.length && ag.length && ag.every((id) => c.marks.includes(id)));
  if (card === -1) return cancelPending(s, ctx);
  if (s.pending && s.pending.i === card) return;
  s.pending = { i: card, at: Date.now() + REVEAL_DELAY, ms: REVEAL_DELAY };
  ctx.setTimer('cn-reveal', REVEAL_DELAY, () => {
    if (s.pending && s.pending.i === card) reveal(s, card, ctx);
  });
}

// Подсказка: слово + силы слов (0 < x ≤ 1, до сотых)
function parseClue(msg) {
  const word = String(msg.word || '').trim().slice(0, 30);
  if (!word || /\s/.test(word)) return { error: 'Подсказка — одно слово' };
  const raw = (Array.isArray(msg.slots) && msg.slots.length ? msg.slots : [1]).map((x) => String(x).trim().replace(',', '.'));
  if (raw.length > MAX_SLOTS) return { error: `Не больше ${MAX_SLOTS} слов в одной подсказке` };
  if (raw.some((x) => !/^(0(\.\d{1,2})?|1(\.0{1,2})?|\.\d{1,2})$/.test(x) || !(parseFloat(x) > 0)))
    return { error: 'Сила слова — число больше 0 и не больше 1, до двух знаков: 1, 0.73, 0.5' };
  const slots = raw.map((x) => ({ v: Math.round(parseFloat(x) * 100) / 100, done: false })).sort((a, b) => b.v - a.v);
  return { word, slots };
}
const clueText = (c) => `${c.word} ${c.slots.map((x) => `(${x.v})`).join(' ')}`;

function action(s, pid, msg, ctx) {
  const name = ctx.room.players.get(pid)?.name || '?';
  switch (msg.type) {
    case 'join': {
      const t = msg.team === 'blue' ? 'blue' : msg.team === 'red' ? 'red' : null;
      // Во время партии команду не меняют: можно только зрителю войти в команду
      // или агенту занять пустое место капитана своей команды
      const live = s.step !== 'setup' && !s.winner;
      if (live && s.team[pid] && t !== s.team[pid]) return 'Сменить команду можно после окончания партии';
      if (live && s.team[pid] && s.captain[t] === pid && !msg.captain) return 'Уступить место капитана можно после окончания партии';
      if (!t) delete s.team[pid];
      else s.team[pid] = t;
      s.cards.forEach((c) => (c.marks = c.marks.filter((m) => m !== pid)));
      for (const c of ['red', 'blue']) if (s.captain[c] === pid && s.team[pid] !== c) s.captain[c] = null;
      if (msg.captain && t) {
        if (s.captain[t] && s.captain[t] !== pid && ctx.room.players.get(s.captain[t])?.connected) return 'У этой команды уже есть капитан';
        s.captain[t] = pid;
      } else if (t && s.captain[t] === pid && msg.captain === false) s.captain[t] = null;
      if (s.ready) delete s.ready[pid]; // сменил роль — подтверди готовность заново
      checkConsensus(s, ctx);
      return;
    }
    case 'ready': {
      if (s.step !== 'setup' && !s.winner) return 'Партия уже идёт';
      if (!s.team[pid]) return 'Сначала выберите команду';
      if (s.ready[pid]) delete s.ready[pid];
      else s.ready[pid] = true;
      checkReady(s, ctx);
      return;
    }
    case 'forceStart': {
      if (!ctx.isHost) return 'Только хост';
      if (s.step !== 'setup' && !s.winner) return;
      newBoard(s, ctx);
      return;
    }
    case 'shuffleTeams': {
      if (!ctx.isHost) return 'Только хост';
      const ids = shuffle(ctx.players().map((p) => p.id));
      s.team = {};
      ids.forEach((id, i) => (s.team[id] = i % 2 ? 'blue' : 'red'));
      s.captain = { red: ids[0] || null, blue: ids[1] || null };
      s.ready = {};
      s.cards.forEach((c) => (c.marks = []));
      cancelPending(s, ctx);
      return;
    }
    case 'clue': {
      if (s.winner) return 'Игра окончена';
      if (s.captain[s.turn] !== pid) return 'Подсказку даёт капитан команды, которая ходит';
      if (s.step !== 'clue') return 'Подсказка уже дана';
      const p = parseClue(msg);
      if (p.error) return p.error;
      s.clue = { id: s.clues.length, word: p.word, slots: p.slots, team: s.turn, by: pid, editUntil: Date.now() + EDIT_MS, at: Date.now() };
      if (s.st && s.turnAt) {
        const think = Date.now() - s.turnAt;
        const prev = s.st.think[pid];
        s.st.think[pid] = { max: Math.max(prev?.max || 0, think), sum: (prev?.sum || 0) + think, n: (prev?.n || 0) + 1 };
      }
      s.clues.push(s.clue);
      s.step = 'guess';
      s.firstClue = false;
      s.log.push({ kind: 'clue', team: s.turn, text: clueText(s.clue), by: name });
      if (s.clock?.over) s.clock.over = 'guess'; // команда отгадывает остатком времени
      else startClock(s, ctx, GUESS_MS);
      return;
    }
    case 'editClue': {
      const c = s.clue;
      if (!c || s.step !== 'guess') return 'Нечего исправлять';
      if (c.by !== pid) return 'Исправить может только автор подсказки';
      if (Date.now() > c.editUntil) return 'Время на исправление вышло (15 секунд)';
      const p = parseClue(msg);
      if (p.error) return p.error;
      c.word = p.word;
      c.slots = p.slots;
      s.log.push({ kind: 'edit', team: c.team, text: clueText(c), by: name });
      return;
    }
    case 'strike': {
      // Капитан зачёркивает слово в своей подсказке: отгадано или «лучше забыть»
      const c = s.clues[msg.clue];
      if (!c) return;
      if (s.captain[c.team] !== pid) return 'Зачёркивать может только капитан этой команды';
      const slot = c.slots[msg.k];
      if (!slot) return;
      slot.done = !slot.done;
      return;
    }
    case 'mark': {
      if (s.winner) return 'Игра окончена';
      if (s.team[pid] !== s.turn) return 'Сейчас ход другой команды';
      if (s.captain[s.turn] === pid) return 'Капитан не выбирает карточки';
      if (s.step !== 'guess') return 'Дождитесь подсказки капитана';
      const c = s.cards[msg.i];
      if (!c || c.revealed) return;
      const had = c.marks.includes(pid);
      const wasOn = s.cards.some((x) => x.marks.includes(pid));
      s.cards.forEach((x) => (x.marks = x.marks.filter((m) => m !== pid)));
      if (!had) c.marks.push(pid);
      if (!had && !c.marks.some((m) => m !== pid)) c.first = pid;
      if (s.st && wasOn) s.st.flips[pid] = (s.st.flips[pid] || 0) + 1; // передумал
      checkConsensus(s, ctx);
      return;
    }
    case 'endTurn': {
      if (s.winner) return;
      const isAgent = s.team[pid] === s.turn && s.captain[s.turn] !== pid;
      if (!isAgent && !ctx.isHost) return 'Передать ход может агент ходящей команды';
      if (s.step !== 'guess' && !ctx.isHost) return 'Сначала нужна подсказка';
      s.log.push({ kind: 'pass', team: s.turn, by: name });
      passTurn(s, ctx);
      return;
    }
    case 'pauseClock': {
      if (!ctx.isHost) return 'Только хост';
      if (!s.clock) return;
      if (s.clock.paused) resumeClock(s, ctx);
      else pauseClock(s, ctx);
      return;
    }
    case 'resetClock': {
      if (!ctx.isHost) return 'Только хост';
      if (s.winner || !s.clock) return;
      const wasPaused = s.clock?.paused;
      startClock(s, ctx, s.step === 'clue' ? clueTime(s) : GUESS_MS);
      if (wasPaused) pauseClock(s, ctx);
      return;
    }
    case 'newBoard': {
      if (!ctx.isHost) return 'Только хост';
      cancelPending(s, ctx);
      newBoard(s, ctx);
      enterSetup(s, ctx);
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid, ctx) {
  const isCap = s.captain.red === pid || s.captain.blue === pid;
  const setup = s.step === 'setup';
  const showAll = (isCap || !!s.winner) && !setup;
  const ownTurn = s.team[pid] === s.turn;
  const c = s.clock;
  return {
    team: s.team,
    captain: s.captain,
    turn: s.turn,
    step: s.step,
    clue: s.clue,
    clues: s.clues,
    winner: s.winner,
    reason: s.reason,
    left: { red: left(s, 'red'), blue: left(s, 'blue') },
    agentsNow: agents(s, ctx).length,
    pending: s.pending,
    ready: s.ready || {},
    needs: setup || s.winner ? setupNeeds(s, ctx) : [],
    clock: c ? { endsAt: c.endsAt, total: c.total, over: c.over || false, paused: c.paused, left: c.paused ? c.left : Math.max(0, c.endsAt - Date.now()) } : null,
    log: s.log.slice(-40),
    summary: s.winner ? summary(s) : null,
    // Простая статистика каждого игрока в этой партии
    pst: setup ? null : { right: s.st?.right || {}, wrong: s.st?.wrong || {}, capHits: s.st?.capHits || {}, lead: s.st?.lead || {} },
    cards: s.cards.map((x) => ({
      w: setup ? '' : x.w, // до старта слова скрыты
      revealed: x.revealed,
      color: x.revealed || showAll ? x.color : null,
      marks: ownTurn ? x.marks : [], // голоса видит только своя команда
    })),
  };
}

function onLeave(s, pid, ctx) {
  delete s.team[pid];
  s.cards.forEach((c) => (c.marks = c.marks.filter((m) => m !== pid)));
  for (const c of ['red', 'blue']) if (s.captain[c] === pid) s.captain[c] = null;
  if (s.ready) delete s.ready[pid];
  checkConsensus(s, ctx);
  checkReady(s, ctx);
}

// Приостановка при уходе в лобби и возврат
function pause(s, ctx) {
  cancelPending(s, ctx);
  if (pauseClock(s, ctx)) s.clock.auto = true;
}
function resume(s, ctx) {
  if (s.clock && s.clock.auto) resumeClock(s, ctx);
  checkConsensus(s, ctx);
}

const isOver = (s) => !!s.winner;
// Очки катки: победившая команда — 1, остальные 0 (дальше переводится в места)
const results = (s) => Object.fromEntries(Object.keys(s.team).map((id) => [id, s.team[id] === s.winner ? 1 : 0]));

function onPresence(s, ctx) {
  checkConsensus(s, ctx);
  checkReady(s, ctx);
}

module.exports = { meta, create, action, view, onLeave, isOver, results, onPresence, pause, resume, stats };
