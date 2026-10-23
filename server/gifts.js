// Подарки и шалости за монеты. Хранятся в комнате: у каждого игрока один обычный слот
// (новый подарок заменяет старый) и отдельный защищённый слот короны.
// Объявление о подарке рассылается всем в комнате событием 'gift'; активные подарки — в состоянии комнаты,
// поэтому после перезагрузки они восстанавливаются, а объявление повторно не проигрывается.

const MIN = 60 * 1000;
const CATALOG = {
  kiss: { price: 20, ms: 5 * MIN },
  rose: { price: 50, ms: 5 * MIN },
  beer: { price: 100, ms: 10 * MIN },
  slap: { price: 150, ms: 5 * MIN },
  whisky: { price: 200, ms: 10 * MIN },
  tomato: { price: 250, ms: 5 * MIN },
  poop: { price: 500, ms: 10 * MIN, anon: true },
  crown: { price: 1000, ms: 15 * MIN, crown: true },
  ring: { price: 1500, ms: 15 * MIN },
  bus: { price: 2000, ms: 15 * MIN },
};
const ORDER = Object.keys(CATALOG);

const live = (slot, now) => slot && slot.until > now;

// Отправка подарка. wallet — { spend(key, n), balance(key) }. Возвращает строку ошибки или объект события
function send(room, fromPid, msg, Wallet, now = Date.now()) {
  const id = String(msg.gift || '');
  const g = CATALOG[id];
  if (!g) return 'Такого подарка нет';
  const to = String(msg.to || '');
  if (to === fromPid) return 'Себе дарить нельзя';
  if (!room.players.has(to)) return 'Этого игрока нет в комнате';
  const from = room.players.get(fromPid);
  // Защита от двойной покупки: одинаковый nonce второй раз не проходит
  room.giftNonces = room.giftNonces || new Map();
  const nonce = String(msg.nonce || '');
  if (nonce && room.giftNonces.has(nonce)) return { dup: true };
  room.gifts = room.gifts || new Map();
  const cur = room.gifts.get(to) || {};
  if (g.crown && live(cur.crown, now)) return 'У игрока уже есть корона — её нельзя перебить';
  if (!Wallet.spend(from.wallet, g.price)) return `Не хватает монет: нужно ${g.price}, у вас ${Wallet.balance(from.wallet)}`;
  if (nonce) {
    room.giftNonces.set(nonce, now); // запоминаем только успешные покупки
    if (room.giftNonces.size > 300) room.giftNonces.delete(room.giftNonces.keys().next().value);
  }
  const slot = { id, at: now, until: now + g.ms };
  if (g.crown) cur.crown = slot;
  else cur.gift = slot;
  room.gifts.set(to, cur);
  return {
    eid: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    gift: id,
    to,
    from: g.anon ? null : fromPid, // какашка — анонимно: отправителя не видит никто
    at: now,
    ms: g.ms,
  };
}

// Активные подарки для состояния комнаты: { pid: { gift: {id, at, until}, crown: {at, until} } }
function view(room, now = Date.now()) {
  const out = {};
  if (!room.gifts) return out;
  for (const [pid, s] of room.gifts) {
    const v = {};
    if (live(s.gift, now)) v.gift = s.gift;
    if (live(s.crown, now)) v.crown = s.crown;
    if (v.gift || v.crown) out[pid] = v;
    else room.gifts.delete(pid);
  }
  return out;
}

const forget = (room, pid) => room.gifts && room.gifts.delete(pid);

module.exports = { CATALOG, ORDER, send, view, forget };
