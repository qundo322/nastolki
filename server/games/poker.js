const { shuffle } = require('../util');

// «Расписной покер» (он же «джокер», «покер на взятки»). Колода 36 карт, джокер — семёрка пик.
// Сдачи: по 1, 2, … до максимума (максимум — столько раз, сколько игроков), обратно до 1,
// потом специальные: бескозырка, мизер, тёмная, золотая. Каждый заказывает, сколько возьмёт взяток.
const SUITS = ['s', 'c', 'd', 'h']; // пики, трефы, бубны, червы
const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11 — валет … 14 — туз
const JOKER = '7s';
const TRICK_MS = 1600; // сколько лежит собранная взятка
const DEAL_END_MS = 5000; // итоги сдачи

const SPECIAL = {
  B: { name: 'Бескозырка', mult: 2, noTrump: true },
  M: { name: 'Мизер', mult: 2, noBid: true },
  T: { name: 'Тёмная', mult: 2, dark: true },
  Z: { name: 'Золотая', mult: 2, noBid: true },
};

const meta = {
  title: 'Расписной покер',
  emoji: '🃏',
  players: '3–6',
  content: '36 карт + джокер',
  short: 'Заказывай, сколько возьмёшь взяток, — и возьми ровно столько. Перебор и недобор наказываются. Джокер — семёрка пик.',
  rules: [
    'Каждую сдачу карт на руках становится больше: 1, 2, 3… до максимума, потом обратно. В конце — бескозырка, мизер, тёмная и золотая.',
    'После сдачи каждый заказывает, сколько возьмёт взяток (или «пас»). Сдающий заказывает последним, и сумма заказов не может быть равна числу карт.',
    'Ходите в масть; нет масти — козырем; нет козыря — любой картой. Взятку берёт старший козырь или старшая карта масти захода.',
    'Джокер (семёрка пик) кладётся в любой момент: можно забрать им взятку или скинуть. Зайти с джокера — потребовать старшие козыри или старшую карту масти, либо сыграть его как самую младшую.',
    'Очки: взял ровно заказ — по 10 за взятку; пас выполнен — 5; перебор — по 1 за взятку; недобор — минус 10 за каждую недостающую. Спецсдачи — вдвое. Золотая — +20 за взятку, мизер — −20.',
  ],
  restartActions: ['restart'],
  settings: [
    {
      key: 'length',
      label: 'Длина игры',
      type: 'select',
      options: [
        { v: 'mini', t: 'Быстрая: 1…максимум, золотая и мизер' },
        { v: 'short', t: 'Короткая: туда-обратно + 4 спецсдачи' },
        { v: 'full', t: 'Полная, как на бумаге' },
      ],
      default: 'short',
    },
  ],
};

const suitOf = (c) => c.slice(-1);
const rankOf = (c) => Number(c.slice(0, -1));
const isJoker = (c) => c === JOKER;

function schedule(n, length) {
  const max = Math.min(9, Math.floor(36 / n));
  const up = Array.from({ length: max - 1 }, (_, i) => i + 1);
  const down = up.slice().reverse();
  const deals = [];
  const add = (k, sp) => deals.push({ k, sp: sp || null });
  if (length === 'mini') {
    up.forEach((k) => add(k));
    add(max);
    add(max, 'Z');
    add(max, 'M');
  } else if (length === 'full') {
    up.forEach((k) => add(k));
    for (let i = 0; i < n; i++) add(max);
    down.forEach((k) => add(k));
    for (const sp of ['B', 'M', 'T', 'Z']) for (let i = 0; i < n; i++) add(max, sp);
  } else {
    up.forEach((k) => add(k));
    add(max);
    down.forEach((k) => add(k));
    for (const sp of ['B', 'M', 'T', 'Z']) add(max, sp);
  }
  return deals;
}

function create(ctx, st) {
  const ids = shuffle(ctx.players().map((p) => p.id));
  if (ids.length < 3) return 'Для «Расписного покера» нужно минимум 3 игрока';
  if (ids.length > 6) return 'В «Расписной покер» колодой 36 карт играют максимум вшестером';
  const length = ['mini', 'short', 'full'].includes(st.length) ? st.length : 'short';
  const s = {
    order: ids,
    length,
    deals: schedule(ids.length, length),
    di: -1, // номер сдачи
    dealer: Math.floor(Math.random() * ids.length) - 1,
    total: Object.fromEntries(ids.map((id) => [id, 0])),
    sheet: [], // строки таблицы: { label, sp, rows: { pid: { bid, took, pts, total } } }
    winner: null,
  };
  nextDeal(s, ctx);
  return s;
}

function nextDeal(s, ctx) {
  s.di++;
  if (s.di >= s.deals.length) {
    s.phase = 'over';
    const best = Math.max(...s.order.map((id) => s.total[id]));
    s.winner = s.order.filter((id) => s.total[id] === best);
    return;
  }
  const n = s.order.length;
  s.dealer = (s.dealer + 1) % n;
  const { k, sp } = s.deals[s.di];
  const deck = shuffle(SUITS.flatMap((su) => RANKS.map((r) => r + su)));
  s.hands = {};
  // раздаём по кругу, начиная с игрока слева от сдающего
  for (let i = 0; i < k; i++) for (let j = 1; j <= n; j++) {
    const pid = s.order[(s.dealer + j) % n];
    (s.hands[pid] = s.hands[pid] || []).push(deck.pop());
  }
  // козырь — следующая карта колоды; если колода кончилась — последняя карта сдающего
  const sideCard = deck.length ? deck.pop() : s.hands[s.order[s.dealer]][k - 1];
  s.trumpCard = SPECIAL[sp]?.noTrump ? null : sideCard;
  s.trump = !s.trumpCard || isJoker(s.trumpCard) ? null : suitOf(s.trumpCard);
  s.k = k;
  s.sp = sp;
  s.bids = {};
  s.took = Object.fromEntries(s.order.map((id) => [id, 0]));
  s.trick = []; // [{ pid, c, j: режим джокера }]
  s.lastTrick = null;
  s.first = (s.dealer + 1) % n;
  s.turn = s.first;
  s.phase = SPECIAL[sp]?.noBid ? 'play' : 'bid';
  s.dealAt = Date.now();
}

const cur = (s) => s.order[s.turn];
const handOf = (s, pid) => s.hands[pid] || [];

// Сколько может заказать игрок (сдающему нельзя «закрыть» сумму)
function forbiddenBid(s, pid) {
  const n = s.order.length;
  if (pid !== s.order[s.dealer]) return null;
  const sum = Object.values(s.bids).reduce((a, b) => a + b, 0);
  const f = s.k - sum;
  return Object.keys(s.bids).length === n - 1 && f >= 0 && f <= s.k ? f : null;
}

// Требование захода: { suit, high } — масть захода и нужно ли класть старшую карту
function demand(s) {
  if (!s.trick.length) return null;
  const lead = s.trick[0];
  if (isJoker(lead.c)) {
    if (lead.j === 'low') return s.trick[1] ? { suit: suitOf(s.trick[1].c), high: false } : null;
    if (lead.j?.startsWith('high-')) return { suit: lead.j.slice(5), high: true };
    return null;
  }
  return { suit: suitOf(lead.c), high: false };
}

// Можно ли сыграть эту карту (джокер — всегда)
function legal(s, pid, c) {
  const hand = handOf(s, pid);
  if (!hand.includes(c)) return 'Такой карты нет';
  if (isJoker(c)) return null;
  const d = demand(s);
  if (!d) return null;
  const real = hand.filter((x) => !isJoker(x));
  const ofSuit = real.filter((x) => suitOf(x) === d.suit);
  if (ofSuit.length) {
    if (suitOf(c) !== d.suit) return 'Нужно ходить в масть';
    if (d.high && rankOf(c) !== Math.max(...ofSuit.map(rankOf))) return 'Джокер потребовал старшую карту этой масти';
    return null;
  }
  const trumps = s.trump ? real.filter((x) => suitOf(x) === s.trump) : [];
  if (trumps.length && suitOf(c) !== s.trump) return 'Масти нет — нужно бить козырем';
  return null;
}

// Кто берёт взятку
function trickWinner(s) {
  const t = s.trick;
  const jk = t.find((x) => isJoker(x.c));
  if (jk && jk.j !== 'low') return jk.pid; // джокер «забрать» (или заход с требованием) — взятка его
  const d = demand(s);
  const real = t.filter((x) => !isJoker(x.c));
  const trumps = s.trump ? real.filter((x) => suitOf(x.c) === s.trump) : [];
  const pool = trumps.length ? trumps : real.filter((x) => d && suitOf(x.c) === d.suit);
  if (!pool.length) return (real[0] || t[0]).pid;
  return pool.reduce((a, b) => (rankOf(b.c) > rankOf(a.c) ? b : a)).pid;
}

function scoreDeal(s) {
  const sp = SPECIAL[s.sp];
  const mult = sp ? sp.mult : 1;
  const row = { label: s.sp || String(s.k), sp: s.sp, rows: {} };
  for (const id of s.order) {
    const t = s.took[id] || 0;
    let pts;
    if (s.sp === 'Z') pts = 10 * t * mult;
    else if (s.sp === 'M') pts = -10 * t * mult;
    else {
      const b = s.bids[id] || 0;
      if (b === 0) pts = t === 0 ? 5 : t;
      else if (t === b) pts = 10 * b;
      else if (t > b) pts = t;
      else pts = -10 * (b - t);
      pts *= mult;
    }
    s.total[id] += pts;
    row.rows[id] = { bid: s.sp === 'Z' || s.sp === 'M' ? null : s.bids[id] ?? 0, took: t, pts, total: s.total[id] };
  }
  s.sheet.push(row);
  s.dealResult = row;
}

function action(s, pid, msg, ctx) {
  if (msg.type === 'restart') {
    if (!ctx.isHost) return 'Только хост';
    for (const id of s.order) s.total[id] = 0;
    s.sheet = [];
    s.winner = null;
    s.di = -1;
    ctx.clearTimer('pk');
    nextDeal(s, ctx);
    return;
  }
  if (msg.type === 'redeal') {
    // хост пересдаёт текущую сдачу (кто-то ушёл, ошиблись и т. п.)
    if (!ctx.isHost) return 'Только хост';
    if (s.phase === 'over') return;
    ctx.clearTimer('pk');
    s.di--;
    s.dealer = (s.dealer - 1 + s.order.length) % s.order.length;
    nextDeal(s, ctx);
    return;
  }
  if (s.phase === 'over') return 'Игра окончена';
  if (!s.order.includes(pid)) return 'Вы не в игре';
  switch (msg.type) {
    case 'bid': {
      if (s.phase !== 'bid') return 'Сейчас не заказывают';
      if (pid !== cur(s)) return 'Сейчас заказывает другой игрок';
      const b = Math.floor(Number(msg.n));
      if (!(b >= 0 && b <= s.k)) return 'Заказ — от 0 до ' + s.k;
      if (forbiddenBid(s, pid) === b) return `Сдающему нельзя заказать ${b}: сумма заказов не должна равняться числу карт`;
      s.bids[pid] = b;
      if (Object.keys(s.bids).length === s.order.length) {
        s.phase = 'play';
        s.turn = s.first;
      } else s.turn = (s.turn + 1) % s.order.length;
      return;
    }
    case 'play': {
      if (s.phase !== 'play') return 'Сейчас не ходят';
      if (pid !== cur(s)) return 'Сейчас ходит другой игрок';
      const c = String(msg.c || '');
      const err = legal(s, pid, c);
      if (err) return err;
      let j = null;
      if (isJoker(c)) {
        const lead = !s.trick.length;
        const ok = lead ? ['low', ...(s.trump ? ['high-' + s.trump] : []), ...SUITS.map((x) => 'high-' + x)] : ['high', 'low'];
        j = String(msg.j || '');
        if (!ok.includes(j)) return 'Выберите, как сыграть джокер';
      }
      s.hands[pid] = handOf(s, pid).filter((x) => x !== c);
      s.trick.push({ pid, c, j });
      if (s.trick.length < s.order.length) {
        s.turn = (s.turn + 1) % s.order.length;
        return;
      }
      // взятка собрана
      const w = trickWinner(s);
      s.took[w]++;
      s.lastTrick = { cards: s.trick, winner: w, at: Date.now() };
      s.phase = 'trick';
      ctx.setTimer('pk', TRICK_MS, () => {
        s.trick = [];
        s.turn = s.order.indexOf(w);
        if (Object.values(s.hands).every((h) => !h.length)) {
          scoreDeal(s);
          s.phase = 'dealEnd';
          ctx.setTimer('pk', DEAL_END_MS, () => nextDeal(s, ctx));
        } else s.phase = 'play';
      });
      return;
    }
    case 'next': {
      // итоги сдачи посмотрели — хост может не ждать
      if (s.phase !== 'dealEnd' || !ctx.isHost) return;
      ctx.clearTimer('pk');
      nextDeal(s, ctx);
      return;
    }
  }
  return 'Неизвестное действие';
}

function view(s, pid) {
  const sp = SPECIAL[s.sp] || null;
  const hideHand = sp?.dark && s.phase === 'bid';
  const mine = handOf(s, pid);
  const playable = s.phase === 'play' && cur(s) === pid ? mine.filter((c) => !legal(s, pid, c)) : [];
  return {
    phase: s.phase,
    order: s.order,
    dealer: s.order[s.dealer],
    turnPid: s.phase === 'bid' || s.phase === 'play' ? cur(s) : null,
    deal: s.di + 1,
    deals: s.deals.length,
    k: s.k,
    sp: s.sp,
    spName: sp ? sp.name : null,
    noBid: !!sp?.noBid,
    dark: !!sp?.dark,
    trumpCard: s.trumpCard,
    trump: s.trump,
    joker: JOKER,
    hand: hideHand ? mine.map(() => null) : sortHand(mine, s.trump),
    playable,
    counts: Object.fromEntries(s.order.map((id) => [id, handOf(s, id).length])),
    bids: s.bids,
    took: s.took,
    forbidden: s.phase === 'bid' && cur(s) === pid ? forbiddenBid(s, pid) : null,
    trick: s.trick,
    lastTrick: s.lastTrick,
    total: s.total,
    sheet: s.sheet,
    plan: s.deals.map((d) => d.sp || String(d.k)),
    dealResult: s.phase === 'dealEnd' ? s.dealResult : null,
    winner: s.winner,
    inGame: s.order.includes(pid),
  };
}

// Рука по мастям: козыри справа, внутри масти — по старшинству, джокер в конце
function sortHand(h, trump) {
  const order = (c) => (isJoker(c) ? 999 : (suitOf(c) === trump ? 400 : SUITS.indexOf(suitOf(c)) * 100) + rankOf(c));
  return h.slice().sort((a, b) => order(a) - order(b));
}

function onLeave(s, pid, ctx) {
  const i = s.order.indexOf(pid);
  if (i < 0 || s.phase === 'over') return;
  s.order.splice(i, 1);
  delete s.total[pid];
  if (s.order.length < 2) {
    s.phase = 'over';
    s.winner = s.order.slice();
    return;
  }
  // Пересдаём текущую сдачу без ушедшего
  ctx.clearTimer('pk');
  s.deals = s.deals.map((d) => ({ ...d, k: Math.min(d.k, Math.min(9, Math.floor(36 / s.order.length))) }));
  s.di--;
  s.dealer = Math.min(s.dealer, s.order.length - 1) - 1;
  nextDeal(s, ctx);
}

const isOver = (s) => s.phase === 'over';
const results = (s) => ({ ...s.total });

module.exports = { meta, create, action, view, onLeave, isOver, results, legal, trickWinner, schedule, forbiddenBid };
