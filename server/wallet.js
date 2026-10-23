// Монеты игроков. Кошелёк привязан к токену браузера (тот же, что и для входа в комнату),
// поэтому монеты общие для всех комнат и переживают перезагрузку страницы.
// Сервер хранит кошельки в памяти и раз в 30 секунд сбрасывает их в файл (data/wallets.json).
//
// Начисление: 300 монет за каждые 10 минут активной игровой сессии.
//  - отсчёт идёт только после запуска первой игры в комнате;
//  - сессия считается активной, пока идёт игра, и ещё 10 минут после неё (переход между играми);
//  - считается только время, когда игрок в сети; прогресс текущего интервала сохраняется;
//  - один кошелёк копит время один раз, даже если открыт в нескольких вкладках или комнатах.
const fs = require('fs');
const path = require('path');

const EARN = 300;
const EVERY_MS = Number(process.env.COIN_EVERY_MS) || 10 * 60 * 1000; // в тестах можно ускорить
const LOBBY_GRACE_MS = 10 * 60 * 1000; // пауза между играми, которая ещё считается сессией
const TICK_MS = Math.min(5000, Math.max(200, Math.floor(EVERY_MS / 5)));

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'wallets.json');
const wallets = new Map(); // key → { coins, prog }
let dirty = false;

try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const [k, w] of Object.entries(raw)) wallets.set(k, { coins: Math.max(0, Number(w.coins) || 0), prog: Math.max(0, Number(w.prog) || 0) });
} catch {}

function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(Object.fromEntries(wallets)));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) {
    console.error('wallets save', e.message);
  }
}
setInterval(save, 30000).unref();
process.on('SIGTERM', () => {
  save();
  process.exit(0);
});

const get = (key) => {
  if (!key) return { coins: 0, prog: 0 };
  let w = wallets.get(key);
  if (!w) wallets.set(key, (w = { coins: 0, prog: 0 }));
  return w;
};
const balance = (key) => get(key).coins;

// Списать атомарно: хватает — списали и вернули true
function spend(key, n) {
  const w = get(key);
  if (w.coins < n) return false;
  w.coins -= n;
  dirty = true;
  return true;
}

// Сессия комнаты: включается первой игрой, гаснет после долгого простоя без игры
function sessionActive(room, now) {
  if (room.game) {
    room.sessionOn = true;
    room.lastGameAt = now;
    return true;
  }
  if (!room.sessionOn) return false;
  if (now - (room.lastGameAt || 0) > LOBBY_GRACE_MS) {
    room.sessionOn = false;
    return false;
  }
  return true;
}

// Раз в 5 секунд: начисляем время всем, кто в сети в активных сессиях. onEarn(room, pid, coins, add)
function start(rooms, onEarn) {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min(now - last, TICK_MS * 3); // после «засыпания» сервера не начисляем лишнего
    last = now;
    const seen = new Set();
    for (const room of rooms.values()) {
      if (!sessionActive(room, now)) continue;
      for (const p of room.players.values()) {
        if (!p.connected || !p.wallet || seen.has(p.wallet)) continue;
        seen.add(p.wallet);
        const w = get(p.wallet);
        w.prog += dt;
        dirty = true;
        let add = 0;
        while (w.prog >= EVERY_MS) {
          w.prog -= EVERY_MS;
          w.coins += EARN;
          add += EARN;
        }
        if (add) onEarn(room, p.id, w.coins, add);
      }
    }
  }, TICK_MS).unref();
}

module.exports = { get, balance, spend, start, save, EARN, EVERY_MS };
