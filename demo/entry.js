// Демо-режим: «сервер» работает прямо в странице, игроки — вкладки в нижней панели.
const GAMES = {
  codenames: require('../server/games/codenames'),
  alias: require('../server/games/alias'),
  spyfall: require('../server/games/spyfall'),
  whoami: require('../server/games/whoami'),
  justone: require('../server/games/justone'),
  quiz: require('../server/games/quiz'),
  majority: require('../server/games/majority'),
};

const Waiting = require('../server/waiting');
for (const k of Object.keys(GAMES)) GAMES[k] = Waiting.wrap(GAMES[k]);
const Tour = require('../server/tournament');
const Session = require('../server/session');
const Radio = require('../server/radio');
window.AVATAR_BASE = null; // в демо картинок нет — инициалы

// ---- окружение для app.js ----
const META = Object.entries(GAMES).map(([id, g]) => ({ id, ...g.meta }));
const origFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = (u, o) =>
  String(u).endsWith('/api/games')
    ? Promise.resolve({ json: () => Promise.resolve(META) })
    : origFetch(u, o);
try {
  history.replaceState = () => {};
} catch {}
window.confirm = () => true; // в демо подтверждения не спрашиваем
const op = window.prompt;
window.prompt = (m, d) => {
  try {
    return op.call(window, m, d);
  } catch {
    return null;
  }
};

// ---- комната ----
const uid = () => Math.random().toString(16).slice(2, 14);
const room = {
  code: 'DEMO',
  hostId: null,
  players: new Map(),
  order: [],
  gameType: 'codenames',
  game: null,
  timers: new Map(),
  chat: [],
  tour: null,
  suspended: null,
};
const NAMES = ['Влад', 'Дима', 'Оля', 'Саша', 'Мила', 'Костя', 'Аня', 'Женя', 'Таня', 'Рома', 'Лена', 'Игорь'];
// Игроки демо: ник + реальное имя (видно при наведении на аватар)
const BOTS = [
  ['Влад', 'Владислав'], ['Костя', 'Константин'], ['Руслан', ''], ['Ян', 'Ян Ковальчук'], ['Вадим Б.', 'Вадим Бондаренко'],
  ['Святослав', ''], ['Юрий', 'Юрий Мельник'], ['Оля', 'Ольга'], ['Мила', ''], ['Рома', 'Роман'],
];
const nickKey = (n) => String(n || '').trim().toLowerCase().replace(/ё/g, 'е');
// В демо нет сервера картинок — фото хранится как есть (data:image/...)
const demoPhoto = (u) => (typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(u) && u.length < 220000 ? u : null);
function addPlayer(name, real = '') {
  const id = uid();
  room.players.set(id, { id, name, real, avatar: null, connected: true, sockets: new Set([1]) });
  room.order.push(id);
  if (!room.hostId) room.hostId = id;
  return id;
}
BOTS.slice(0, 5).forEach(([n, r]) => addPlayer(n, r));
let active = room.hostId;
let entered = false; // демо стартует с экрана входа
const lastView = {};

function makeCtx() {
  return {
    room,
    players: () => room.order.map((id) => room.players.get(id)).filter(Boolean),
    broadcast,
    setTimer(key, ms, fn) {
      clearTimeout(room.timers.get(key));
      room.timers.set(
        key,
        setTimeout(() => {
          room.timers.delete(key);
          fn();
          broadcast();
        }, ms)
      );
    },
    clearTimer(key) {
      clearTimeout(room.timers.get(key));
      room.timers.delete(key);
    },
  };
}
const clearTimers = () => {
  for (const t of room.timers.values()) clearTimeout(t);
  room.timers.clear();
};

function viewFor(pid) {
  const g = room.game ? GAMES[room.game.type] : null;
  return {
    me: pid,
    serverNow: Date.now(),
    room: {
      code: room.code,
      hostId: room.hostId,
      gameType: room.gameType,
      players: room.order.map((id) => room.players.get(id)).map((p) => ({ id: p.id, name: p.name, real: p.real || '', connected: p.connected, avatar: p.avatar })),
      chat: room.chat.slice(-50),
      radio: Radio.view(room),
      tour: Tour.publicTour(room.tour),
      suspended: Session.publicSuspended(room),
    },
    game: g ? { type: room.game.type, ...g.view(room.game.state, pid, makeCtx()) } : null,
  };
}

// ---- фейковый сокет ----
const handlers = {};
const fire = (ev, data) => (handlers[ev] || []).forEach((f) => f(data));
function broadcast() {
  Tour.check(room.tour, room.game, GAMES, makeCtx());
  for (const id of room.order) lastView[id] = viewFor(id);
  if (entered && lastView[active]) fire('state', lastView[active]);
  renderBar();
}

function removePlayer(pid) {
  room.players.delete(pid);
  room.order = room.order.filter((x) => x !== pid);
  if (room.game) {
    const g = GAMES[room.game.type];
    g.onLeave && g.onLeave(room.game.state, pid, makeCtx());
  }
  if (room.hostId === pid) room.hostId = room.order[0];
  if (active === pid) active = room.hostId;
}

function handle(pid, ev, msg = {}) {
  const host = room.hostId === pid;
  const onlyHost = () => (host ? null : 'Это может сделать только хост');
  switch (ev) {
    case 'createRoom':
    case 'joinRoom': {
      // В демо вход по нику: такой ник уже есть — играем за него
      const nick = String(msg.name || '').trim().slice(0, 24);
      if (!nick) return { error: 'Введите никнейм' };
      let seat = [...room.players.values()].find((p) => nickKey(p.name) === nickKey(nick));
      if (!seat) seat = room.players.get(addPlayer(nick));
      seat.real = String(msg.real || '').trim().slice(0, 40);
      seat.avatar = demoPhoto(msg.avatar);
      active = seat.id;
      if (ev === 'createRoom' && !room.game) room.hostId = seat.id;
      entered = true;
      return { ok: true, code: room.code, pid: seat.id };
    }
    case 'uploadAvatar': {
      const u = demoPhoto(msg.data);
      return u ? { ok: true, url: u } : { error: 'Нужна картинка JPEG, PNG или WebP' };
    }
    case 'setAvatar': {
      if (msg.avatar == null) room.players.get(pid).avatar = null;
      else {
        const u = demoPhoto(msg.avatar);
        if (!u) return 'Фото не найдено — загрузите ещё раз';
        room.players.get(pid).avatar = u;
      }
      return;
    }
    case 'rename': {
      const p = room.players.get(pid);
      if (msg.name != null) {
        const n = String(msg.name).trim().slice(0, 24);
        if (!n) return 'Введите никнейм';
        if ([...room.players.values()].some((x) => x !== p && nickKey(x.name) === nickKey(n))) return 'Такой ник уже есть в комнате';
        p.name = n;
      }
      if (msg.real != null) p.real = String(msg.real).trim().slice(0, 40);
      return;
    }
    case 'chat':
      if (String(msg.text || '').trim())
        room.chat.push({ id: uid(), pid, name: room.players.get(pid).name, text: String(msg.text).slice(0, 300), at: Date.now() });
      return;
    case 'radio':
      return Radio.handle(room, pid, msg, room.hostId === pid);
    case 'leaveRoom':
      removePlayer(pid);
      return;
    case 'kick':
      return onlyHost() || removePlayer(msg.target);
    case 'makeHost':
      if (onlyHost()) return onlyHost();
      room.hostId = msg.target;
      return;
    case 'selectGame':
      if (onlyHost()) return onlyHost();
      if (room.game) return 'Сначала завершите текущую игру';
      room.gameType = msg.type;
      return;
    case 'startGame':
      if (onlyHost()) return onlyHost();
      return startGame(room.gameType, msg.settings);
    case 'stopGame':
      if (onlyHost()) return onlyHost();
      Session.suspend(room, GAMES, makeCtx, clearTimers);
      return;
    case 'resumeGame':
      if (onlyHost()) return onlyHost();
      if (room.game) return 'Игра уже идёт';
      return Session.resume(room, GAMES, makeCtx);
    case 'startTour': {
      if (onlyHost()) return onlyHost();
      const plan = (msg.plan || []).filter((x) => GAMES[x.type]);
      if (!plan.length) return 'Выберите хотя бы одну игру';
      room.suspended = null;
      room.tour = Tour.makeTour(plan);
      const err = startTourGame();
      if (err) room.tour = null;
      return err;
    }
    case 'tourNext': {
      if (onlyHost()) return onlyHost();
      const t = room.tour;
      if (!t) return;
      if (t.phase === 'done') {
        clearTimers();
        room.game = null;
        t.phase = 'final';
        return;
      }
      if (t.phase !== 'between') return 'Катка ещё не закончена';
      t.idx++;
      return startTourGame();
    }
    case 'tourEnd':
      if (onlyHost()) return onlyHost();
      clearTimers();
      room.game = null;
      room.tour = null;
      return;
    case 'action': {
      if (!room.game) return 'Игра не запущена';
      if (room.tour) {
        if (room.tour.phase !== 'play') return 'Катка окончена — ждём хоста';
        if ((GAMES[room.game.type].meta.restartActions || []).includes(msg.type)) return 'В марафоне катку не перезапустить';
      }
      const ctx = makeCtx();
      ctx.isHost = host;
      return GAMES[room.game.type].action(room.game.state, pid, msg, ctx);
    }
  }
}

function startGame(type, settings) {
  return Session.startGame(room, GAMES, makeCtx, clearTimers, type, settings);
}
function startTourGame() {
  const item = room.tour.queue[room.tour.idx];
  const err = startGame(item.type, item.settings);
  if (err) return `${GAMES[item.type].meta.title}: ${err}`;
  room.tour.phase = 'play';
}

const socket = {
  id: 'demo',
  on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
  },
  emit(ev, data, cb) {
    let r;
    try {
      r = handle(active, ev, data);
    } catch (e) {
      console.error(e);
      r = 'Ошибка: ' + e.message;
    }
    const res = typeof r === 'string' ? { error: r } : r || { ok: true };
    setTimeout(() => {
      cb && cb(res);
      broadcast();
    }, 0);
  },
};
window.io = () => {
  setTimeout(() => {
    fire('connect');
    broadcast();
  }, 0);
  return socket;
};

// ---- панель «Смотреть как» ----
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function hint() {
  const g = room.game;
  if (room.tour && room.tour.phase === 'final') return 'Марафон окончен — турнирная таблица.';
  if (room.tour && room.tour.phase !== 'play') return 'Катка окончена — хост запускает следующую.';
  if (!g && room.suspended) return 'Игра на паузе — хост может вернуться к ней из лобби.';
  if (!g) return 'Вы хост — выберите одну игру или соберите марафон.';
  if (!g.state.inner) return 'Ждём игроков — когда все зайдут, хост жмёт «Начать игру».';
  const s = g.state.inner;
  const n = (id) => room.players.get(id)?.name || '?';
  switch (g.type) {
    case 'codenames':
      if (s.step === 'setup' || s.winner) return 'Подготовка: переключайтесь по игрокам и жмите зелёную «Готов» — когда готовы все, партия начнётся.';
      if (!s.captain[s.turn]) return 'Выберите капитанов: переключитесь на игрока и нажмите «Стать капитаном».';
      return s.step === 'clue'
        ? `Подсказку пишет капитан — ${n(s.captain[s.turn])}.`
        : 'Карточка откроется, когда ВСЕ агенты ходящей команды нажмут на неё — переключайтесь по игрокам.';
    case 'alias':
      return s.phase === 'ready' || s.phase === 'running' || s.phase === 'review' ? `Объясняет ${n(s.explainer)}.` : '';
    case 'spyfall':
      return s.phase === 'play'
        ? `Шпион: ${s.spies.map(n).join(', ')} (подсказка только в демо).`
        : s.phase === 'guessing'
          ? 'Переключитесь на мирных и нажмите «угадал / не угадал» — решает большинство.'
          : '';
    case 'whoami':
      return s.phase === 'write' ? 'Каждый загадывает персонажа соседу — переключайтесь по игрокам.' : `Ходит ${n(s.order[s.turn])}.`;
    case 'quiz':
      return s.phase === 'answer' ? 'Ответ — число. Переключайтесь по игрокам и ответьте за каждого.' : '';
    case 'majority':
      return s.phase === 'answer'
        ? 'Переключайтесь по игрокам и ответьте за каждого — совпадения приносят очки.'
        : s.phase === 'review'
          ? 'Хост может склеить похожие ответы: нажмите на группу, потом на ту, куда её добавить.'
          : '';
    case 'justone':
      return s.phase === 'result' && s.correct && !s.heart
        ? `${n(s.guesser)} отмечает лучшую подсказку.`
        : `Угадывает ${n(s.guesser)}; остальные пишут подсказки.`;
  }
  return '';
}
const bar = document.createElement('div');
bar.id = 'demo-bar';
if (document.body) document.body.appendChild(bar);
else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));
function renderBar() {
  if (!entered) {
    bar.innerHTML = '<div class="db-row"><span class="db-l">Демо</span><span class="db-hint">Выберите себя и нажмите «Создать комнату» — остальные игроки уже ждут внутри.</span></div>';
    return;
  }
  bar.innerHTML = `<div class="db-row"><button class="db-p exit" data-demo-exit>← Вход</button><span class="db-l">Смотреть как:</span>${room.order
    .map((id) => {
      const p = room.players.get(id);
      return `<button class="db-p ${id === active ? 'on' : ''}" data-demo-pid="${id}">${esc(p.name)}${id === room.hostId ? ' · хост' : ''}</button>`;
    })
    .join('')}${room.order.length < 20 ? '<button class="db-p add" data-demo-add>+ игрок</button>' : ''}</div><div class="db-hint">${esc(hint())}</div>`;
}
bar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.demoExit !== undefined) {
    entered = false;
    fire('kicked');
    renderBar();
    return;
  }
  if (b.dataset.demoAdd !== undefined) {
    const free = BOTS.find(([n]) => ![...room.players.values()].some((x) => nickKey(x.name) === nickKey(n)));
    if (free) addPlayer(free[0], free[1]);
    else addPlayer('Гость ' + room.order.length);
  } else if (b.dataset.demoPid) active = b.dataset.demoPid;
  broadcast();
  window.scrollTo({ top: 0 });
});
