// Общие операции с комнатой — используются и сервером, и демо-версией.

// Пиксель-аватар: 8 параметров, у каждого 10 вариантов (0–9)
const AVATAR_KEYS = ['s', 'h', 'hc', 'e', 'm', 'b', 'a', 'w']; // фон аватара задаёт игра (цвет команды)
function cleanAvatar(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  for (const k of AVATAR_KEYS) {
    const v = Number(a[k]);
    if (!Number.isInteger(v) || v < 0 || v > 9) return null;
    out[k] = v;
  }
  return out;
}

function startGame(room, GAMES, makeCtx, clearAllTimers, type, settings) {
  const g = GAMES[type];
  clearAllTimers(room);
  const res = g.create(makeCtx(room), settings || {});
  if (typeof res === 'string') return res;
  room.gameType = type;
  room.game = { type, state: res };
  room.suspended = null;
}

// «В лобби» не ломает игру: она ставится на паузу и к ней можно вернуться
function suspend(room, GAMES, makeCtx, clearAllTimers) {
  if (room.game) {
    const g = GAMES[room.game.type];
    g.pause && g.pause(room.game.state, makeCtx(room), 'suspend');
    room.suspended = { game: room.game, tour: room.tour };
  } else room.suspended = null;
  clearAllTimers(room);
  room.game = null;
  room.tour = null;
}

function resume(room, GAMES, makeCtx) {
  const sp = room.suspended;
  if (!sp) return 'Нет игры на паузе';
  room.game = sp.game;
  room.tour = sp.tour;
  room.gameType = sp.game.type;
  room.suspended = null;
  const g = GAMES[room.game.type];
  g.resume && g.resume(room.game.state, makeCtx(room), 'suspend');
}

const publicSuspended = (room) => (room.suspended ? { type: room.suspended.game.type, tour: !!room.suspended.tour } : null);

// Реакции над аватаркой. Капитан Коднеймс во время партии реагировать не может — иначе это подсказка.
const REACTIONS = ['lol', 'facepalm', 'genius', 'oops', 'fire', 'think'];
function react(room, pid, r) {
  if (!REACTIONS.includes(r)) return 'Неизвестная реакция';
  const g = room.game;
  if (g && g.type === 'codenames') {
    const s = g.state;
    const live = s.step !== 'setup' && !s.winner;
    if (live && (s.captain.red === pid || s.captain.blue === pid)) return 'Капитан не может реагировать во время партии';
  }
  const now = Date.now();
  room.reactLast = room.reactLast || {};
  if (now - (room.reactLast[pid] || 0) < 700) return 'Не так быстро';
  room.reactLast[pid] = now;
  room.reactions = (room.reactions || []).filter((x) => now - x.at < 4000);
  room.reactions.push({ id: now + ':' + pid, pid, r, at: now });
  if (room.reactions.length > 30) room.reactions.shift();
}
const publicReactions = (room) => (room.reactions || []).filter((x) => Date.now() - x.at < 3000);

module.exports = { AVATAR_KEYS, cleanAvatar, startGame, suspend, resume, publicSuspended, react, publicReactions, REACTIONS };
