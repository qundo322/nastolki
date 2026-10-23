// Юнит-тесты «Расписного покера»: масть, козырь, джокер, заказ сдающего, очки
const P = require('../server/games/poker');
const assert = (c, m) => {
  if (!c) throw new Error('ASSERT: ' + m);
};
const players = new Map(['a', 'b', 'c'].map((id) => [id, { id, connected: true }]));
let timer = null;
const ctx = { isHost: true, room: { players }, players: () => [...players.values()], setTimer: (k, ms, fn) => (timer = fn), clearTimer: () => (timer = null) };
const s = P.create(ctx, { length: 'mini' });
assert(s.k === 1 && s.phase === 'bid', 'first deal: 1 card, bidding');
// Подменяем раздачу: 3 карты по одной, козырь — червы
const deal = (hands, trump) => {
  s.hands = hands;
  s.trump = trump;
  s.k = Object.values(hands)[0].length;
  s.bids = {};
  s.took = { a: 0, b: 0, c: 0 };
  s.trick = [];
  s.phase = 'bid';
  s.turn = s.first;
};
s.order = ['a', 'b', 'c'];
s.dealer = 2;
s.first = 0;
deal({ a: ['10s', '6h'], b: ['14s', '8d'], c: ['9d', '7s'] }, 'h');
P.action(s, 'a', { type: 'bid', n: 1 }, ctx);
P.action(s, 'b', { type: 'bid', n: 0 }, ctx);
assert(P.forbiddenBid(s, 'c') === 1, 'dealer cannot close the sum');
assert(P.action(s, 'c', { type: 'bid', n: 1 }, ctx), 'forbidden bid rejected');
P.action(s, 'c', { type: 'bid', n: 2 }, ctx);
assert(s.phase === 'play' && s.turn === 0, 'play starts left of dealer');
P.action(s, 'a', { type: 'play', c: '10s' }, ctx);
assert(P.action(s, 'b', { type: 'play', c: '8d' }, ctx), 'must follow suit');
P.action(s, 'b', { type: 'play', c: '14s' }, ctx);
assert(P.action(s, 'c', { type: 'play', c: '7s' }, ctx), 'joker needs a mode');
P.action(s, 'c', { type: 'play', c: '7s', j: 'high' }, ctx);
assert(s.phase === 'trick' && s.lastTrick.winner === 'c', 'joker takes the trick');
timer();
assert(s.turn === 2 && s.phase === 'play', 'winner leads');
P.action(s, 'c', { type: 'play', c: '9d' }, ctx);
P.action(s, 'a', { type: 'play', c: '6h' }, ctx); // бубен нет — козырь
P.action(s, 'b', { type: 'play', c: '8d' }, ctx);
assert(s.lastTrick.winner === 'a', 'trump beats suit');
timer();
assert(s.phase === 'dealEnd', 'deal finished');
const r = s.dealResult.rows;
assert(r.a.pts === 10 && r.b.pts === 5 && r.c.pts === -10, 'scores: exact +10, pass +5, short −10: ' + JSON.stringify(r));
// Должен бить козырем, если нет масти
deal({ a: ['10s'], b: ['8h'], c: ['9d'] }, 'd');
s.phase = 'play';
s.turn = 0;
P.action(s, 'a', { type: 'play', c: '10s' }, ctx);
assert(!P.legal(s, 'b', '8h'), 'no suit and no trump — any card');
console.log('✓ Расписной покер (юнит)');
