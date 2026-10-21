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

module.exports = { AVATAR_KEYS, cleanAvatar, startGame, suspend, resume, publicSuspended };
