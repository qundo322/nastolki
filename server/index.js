// Сервер сборника настольных игр.
// Всё состояние хранится в памяти — для компании до ~20 человек этого достаточно.
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const GAMES = {
  codenames: require('./games/codenames'),
  alias: require('./games/alias'),
  spyfall: require('./games/spyfall'),
  whoami: require('./games/whoami'),
  justone: require('./games/justone'),
  quiz: require('./games/quiz'),
  majority: require('./games/majority'),
};
// Мало игроков — игра открывается в режиме «Ждём игроков» (см. server/waiting.js)
const Waiting = require('./waiting');
for (const k of Object.keys(GAMES)) GAMES[k] = Waiting.wrap(GAMES[k]);

const Avatars = require('./avatars');
const Tour = require('./tournament');
const Session = require('./session');
const Radio = require('./radio');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS || 20);
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // пустая комната живёт 6 часов

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/games', (_req, res) =>
  res.json(Object.entries(GAMES).map(([id, g]) => ({ id, ...g.meta })))
);
Avatars.route(app);
// Красивые ссылки вида /r/ABCD
app.get('/r/:code', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 20000, pingTimeout: 25000 });

/** @type {Map<string, any>} */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function makeCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no codes left');
}
const newId = () => crypto.randomBytes(6).toString('hex');

function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Игрок';
}
// Реальное имя — необязательное, видно при наведении на аватар
const cleanReal = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
// Ник для сравнения: «Влад», «влад » и «ВЛАД» — один и тот же
const nickKey = (n) => cleanName(n).toLowerCase().replace(/ё/g, 'е');

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(), // pid -> {id, name, connected, sockets:Set}
    tokens: new Map(), // token -> pid
    order: [], // порядок входа
    gameType: 'codenames',
    game: null,
    timers: new Map(),
    lastActive: Date.now(),
    chat: [],
    tour: null,
    suspended: null,
  };
  rooms.set(room.code, room);
  return room;
}

function makeCtx(room) {
  return {
    room,
    players: () => room.order.map((id) => room.players.get(id)).filter(Boolean),
    broadcast: () => broadcast(room),
    setTimer(key, ms, fn) {
      clearTimeout(room.timers.get(key));
      room.timers.set(
        key,
        setTimeout(() => {
          room.timers.delete(key);
          try {
            fn();
          } catch (e) {
            console.error(e);
          }
          broadcast(room);
        }, Math.max(0, ms))
      );
    },
    clearTimer(key) {
      clearTimeout(room.timers.get(key));
      room.timers.delete(key);
    },
  };
}

function clearAllTimers(room) {
  for (const t of room.timers.values()) clearTimeout(t);
  room.timers.clear();
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    gameType: room.gameType,
    players: room.order
      .map((id) => room.players.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, real: p.real || '', connected: p.connected, avatar: p.avatar || null })),
    chat: room.chat.slice(-50),
    radio: Radio.view(room),
    tour: Tour.publicTour(room.tour),
    suspended: Session.publicSuspended(room),
  };
}

function viewFor(room, pid) {
  const g = room.game ? GAMES[room.game.type] : null;
  return {
    me: pid,
    serverNow: Date.now(),
    room: publicRoom(room),
    game: g ? { type: room.game.type, ...g.view(room.game.state, pid, makeCtx(room)) } : null,
  };
}

function broadcast(room) {
  Tour.check(room.tour, room.game, GAMES, makeCtx(room));
  for (const p of room.players.values()) {
    if (!p.sockets.size) continue;
    const v = viewFor(room, p.id);
    for (const sid of p.sockets) io.to(sid).emit('state', v);
  }
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  // Передаём хоста первому подключённому, если старый хост ушёл
  const next = room.order.map((id) => room.players.get(id)).find((p) => p && p.connected);
  if (next) room.hostId = next.id;
}

function removePlayer(room, pid) {
  const p = room.players.get(pid);
  if (!p) return;
  for (const sid of p.sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.emit('kicked');
      s.leave(room.code);
      s.data.room = null;
    }
  }
  room.players.delete(pid);
  room.order = room.order.filter((x) => x !== pid);
  for (const [t, id] of room.tokens) if (id === pid) room.tokens.delete(t);
  if (room.game) {
    const g = GAMES[room.game.type];
    g.onLeave && g.onLeave(room.game.state, pid, makeCtx(room));
  }
  ensureHost(room);
}

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.pid = null;

  const fail = (cb, msg) => cb && cb({ error: msg });

  function attach(room, token, { name, real, avatar }, cb) {
    if (!String(name || '').trim()) return fail(cb, 'Введите никнейм');
    let pid = room.tokens.get(token);
    let p = pid && room.players.get(pid);
    const key = nickKey(name);
    // Тот же ник уже в комнате: если он не в сети — это вы с другого устройства, занимаем его место
    const same = [...room.players.values()].find((x) => nickKey(x.name) === key && x !== p);
    if (same) {
      if (same.connected) return fail(cb, `Ник «${same.name}» уже занят в этой комнате — выберите другой`);
      for (const [t, id] of room.tokens) if (id === same.id) room.tokens.delete(t);
      if (p) removePlayer(room, p.id);
      room.tokens.set(token, same.id);
      pid = same.id;
      p = same;
    }
    if (!p) {
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) return fail(cb, `Комната заполнена (максимум ${MAX_PLAYERS_PER_ROOM})`);
      pid = newId();
      p = { id: pid, name: cleanName(name), connected: true, sockets: new Set() };
      room.players.set(pid, p);
      room.tokens.set(token, pid);
      room.order.push(pid);
      if (!room.hostId) room.hostId = pid;
    }
    p.name = cleanName(name);
    p.real = cleanReal(real);
    p.avatar = Avatars.clean(avatar);
    p.sockets.add(socket.id);
    p.connected = true;
    socket.data.room = room.code;
    socket.data.pid = pid;
    socket.join(room.code);
    room.lastActive = Date.now();
    ensureHost(room);
    presence(room);
    cb && cb({ ok: true, code: room.code, pid });
    broadcast(room);
  }

  function detach() {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const p = room.players.get(socket.data.pid);
    if (p) {
      p.sockets.delete(socket.id);
      if (!p.sockets.size) p.connected = false;
    }
    socket.leave(room.code);
    socket.data.room = null;
    ensureHost(room);
    presence(room);
    room.lastActive = Date.now();
    broadcast(room);
  }

  // Своё фото: клиент присылает уже обрезанный под круг квадрат, получает короткую ссылку
  socket.on('uploadAvatar', ({ data } = {}, cb) => {
    const r = Avatars.put(data);
    cb && cb(r.error ? { error: r.error } : { ok: true, url: r.url });
  });

  socket.on('createRoom', (msg = {}, cb) => {
    if (!msg.token) return fail(cb, 'Нет токена');
    if (!String(msg.name || '').trim()) return fail(cb, 'Введите никнейм');
    detach();
    const room = createRoom();
    attach(room, String(msg.token), msg, cb);
  });

  socket.on('joinRoom', (msg = {}, cb) => {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return fail(cb, 'Комната не найдена — возможно, она закрылась');
    if (!msg.token) return fail(cb, 'Нет токена');
    if (socket.data.room && socket.data.room !== room.code) detach();
    attach(room, String(msg.token), msg, cb);
  });

  // Всё остальное — только внутри комнаты
  function inRoom(handler) {
    return (msg = {}, cb) => {
      const room = rooms.get(socket.data.room);
      if (!room) return fail(cb, 'Вы не в комнате');
      const pid = socket.data.pid;
      if (!room.players.has(pid)) return fail(cb, 'Вас нет в комнате');
      room.lastActive = Date.now();
      try {
        const err = handler(room, pid, msg || {});
        if (err) return fail(cb, err);
        cb && cb({ ok: true });
      } catch (e) {
        console.error(e);
        fail(cb, 'Ошибка сервера');
      }
      broadcast(room);
    };
  }
  const hostOnly = (handler) =>
    inRoom((room, pid, msg) => (room.hostId !== pid ? 'Это может сделать только хост' : handler(room, pid, msg)));

  socket.on('leaveRoom', inRoom((room, pid) => {
    removePlayer(room, pid);
  }));

  socket.on('rename', inRoom((room, pid, { name, real }) => {
    const p = room.players.get(pid);
    if (name != null) {
      if (!String(name).trim()) return 'Введите никнейм';
      const key = nickKey(name);
      if ([...room.players.values()].some((x) => x !== p && nickKey(x.name) === key)) return 'Такой ник уже есть в комнате';
      p.name = cleanName(name);
    }
    if (real != null) p.real = cleanReal(real);
  }));

  // Сменить фото (null — убрать, будут инициалы)
  socket.on('setAvatar', inRoom((room, pid, { avatar }) => {
    if (avatar == null) {
      room.players.get(pid).avatar = null;
      return;
    }
    const av = Avatars.clean(avatar);
    if (!av) return 'Фото не найдено — загрузите ещё раз';
    room.players.get(pid).avatar = av;
  }));

  socket.on('chat', inRoom((room, pid, { text }) => {
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return;
    room.chat.push({ id: newId(), pid, name: room.players.get(pid).name, text: t, at: Date.now() });
    if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
  }));

  // Общее радио комнаты
  socket.on('radio', inRoom((room, pid, msg) => {
    const err = Radio.handle(room, pid, msg, room.hostId === pid);
    if (err) return err;
    for (const item of Radio.untitled(room)) {
      item.tried = true;
      Radio.fetchTitle(item.vid).then((t) => {
        if (!t) return;
        item.title = t;
        const r = Radio.get(room);
        if (r.cur.vid === item.vid && (!r.cur.title || r.cur.title === 'Трек')) r.cur.title = t;
        broadcast(room);
      });
    }
  }));

  socket.on('kick', hostOnly((room, pid, { target }) => {
    if (target === pid) return 'Нельзя выгнать себя';
    removePlayer(room, target);
  }));

  socket.on('makeHost', hostOnly((room, _pid, { target }) => {
    if (!room.players.has(target)) return 'Нет такого игрока';
    room.hostId = target;
  }));

  socket.on('selectGame', hostOnly((room, _pid, { type }) => {
    if (!GAMES[type]) return 'Нет такой игры';
    if (room.game) return 'Сначала завершите текущую игру';
    room.gameType = type;
  }));

  socket.on('startGame', hostOnly((room, _pid, { settings }) => {
    if (room.tour) return 'Идёт марафон';
    return startGame(room, room.gameType, settings);
  }));

  // «В лобби»: игра не удаляется, а ставится на паузу — к ней можно вернуться
  socket.on('stopGame', hostOnly((room) => {
    Session.suspend(room, GAMES, makeCtx, clearAllTimers);
  }));

  socket.on('resumeGame', hostOnly((room) => {
    if (room.game) return 'Игра уже идёт';
    return Session.resume(room, GAMES, makeCtx);
  }));

  // ---- марафон ----
  socket.on('startTour', hostOnly((room, _pid, { plan }) => {
    if (room.game) return 'Сначала завершите текущую игру';
    const clean = (Array.isArray(plan) ? plan : [])
      .filter((x) => GAMES[x.type])
      .map((x) => ({ type: x.type, rounds: Math.min(10, Math.max(1, parseInt(x.rounds, 10) || 1)), settings: x.settings || {} }));
    if (!clean.length) return 'Выберите хотя бы одну игру';
    room.suspended = null;
    room.tour = Tour.makeTour(clean);
    const err = startTourGame(room);
    if (err) room.tour = null;
    return err;
  }));

  socket.on('tourNext', hostOnly((room) => {
    const t = room.tour;
    if (!t) return 'Марафон не запущен';
    if (t.phase === 'done') {
      clearAllTimers(room);
      room.game = null;
      t.phase = 'final';
      return;
    }
    if (t.phase !== 'between') return 'Катка ещё не закончена';
    t.idx++;
    return startTourGame(room);
  }));

  socket.on('tourEnd', hostOnly((room) => {
    clearAllTimers(room);
    room.game = null;
    room.tour = null;
  }));

  socket.on('action', inRoom((room, pid, msg) => {
    if (!room.game) return 'Игра не запущена';
    const g = GAMES[room.game.type];
    if (room.tour) {
      if (room.tour.phase !== 'play') return 'Катка окончена — ждём хоста';
      if ((g.meta.restartActions || []).includes(msg.type)) return 'В марафоне катку не перезапустить';
    }
    const ctx = makeCtx(room);
    ctx.isHost = room.hostId === pid;
    return g.action(room.game.state, pid, msg, ctx);
  }));

  socket.on('disconnect', detach);
});

function startGame(room, type, settings) {
  return Session.startGame(room, GAMES, makeCtx, clearAllTimers, type, settings);
}

function startTourGame(room) {
  const t = room.tour;
  const item = t.queue[t.idx];
  const err = startGame(room, item.type, item.settings);
  if (err) return `${GAMES[item.type].meta.title}: ${err}`;
  t.phase = 'play';
}

// Онлайн/офлайн игрока может менять ход игры (например, консенсус в Коднеймс)
function presence(room) {
  if (!room.game) return;
  const g = GAMES[room.game.type];
  if (g.onPresence) g.onPresence(room.game.state, makeCtx(room));
}

// Уборка заброшенных комнат
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.lastActive > ROOM_TTL_MS) {
      clearAllTimers(room);
      rooms.delete(room.code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`Party games on http://localhost:${PORT}`));
