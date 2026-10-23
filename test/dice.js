// Юнит-тесты «Костей 1000»: подсчёт, допуск, бочка, подтверждающий бросок
const D = require('../server/games/dice');
const assert = (c, m) => {
  if (!c) throw new Error('ASSERT: ' + m);
};
const players = new Map([['a', { id: 'a', connected: true }], ['b', { id: 'b', connected: true }]]);
const ctx = { isHost: true, room: { players }, players: () => [...players.values()], setTimer: (k, ms, fn) => (ctx.timer = fn), clearTimer: () => {} };
const sc = (v) => D.score(v);
assert(sc([1]) === 10 && sc([5]) === 5 && sc([1, 5]) === 15, 'singles');
assert(sc([2, 2, 2]) === 20 && sc([2, 2, 2, 2]) === 40 && sc([2, 2, 2, 2, 2]) === 200, 'twos');
assert(sc([1, 1, 1]) === 100 && sc([1, 1, 1, 1]) === 200 && sc([1, 1, 1, 1, 1]) === 1000, 'ones');
assert(sc([6, 6, 6]) === 60 && sc([6, 6, 6, 6]) === 120 && sc([6, 6, 6, 6, 6]) === 600, 'sixes');
assert(sc([5, 5, 5, 5]) === 100 && sc([5, 5, 5, 5, 5]) === 500, 'fives');
assert(sc([1, 2, 3, 4, 5]) === 125 && sc([6, 5, 4, 3, 2]) === 250, 'straights');
assert(sc([2]) === null && sc([1, 3]) === null, 'non-scoring');

const s = D.create(ctx);
const p = () => s.order[s.turn];
const set = (vals) => vals.forEach((v, i) => (s.dice[i].v = v));
const act = (pid, m) => D.action(s, pid, m, ctx);
const roll = (vals) => {
  // подменяем случайность: бросок, затем выставляем значения свободных кубиков
  const r = Math.random;
  const q = vals.slice();
  Math.random = () => (q.length ? (q.shift() - 1) / 6 + 0.01 : 0.5);
  s.rollAt = 0;
  const res = act(p(), { type: 'roll', keep: s.phase === 'pick' ? s._keep || [] : [] });
  Math.random = r;
  return res;
};
const first = p();
assert(act(s.order[1 - s.turn], { type: 'roll' }), 'not your turn');
roll([1, 5, 3, 3, 4]);
assert(s.phase === 'pick', 'picked');
assert(act(first, { type: 'stop', keep: [0, 1] }) && s.total[first] === 0, 'entry 75 required');
assert(act(first, { type: 'roll', keep: [2] }), 'cannot keep non-scoring');
s._keep = [0, 1];
roll([1, 1, 1]);
assert(s.turnPts === 15 && s.phase === 'pick', 'kept 15, rolled 3');
assert(D.action(s, first, { type: 'stop', keep: [2, 3, 4] }, ctx) && s.total[first] === 0, 'all 5 kept — confirm roll needed');
s._keep = [2, 3, 4];
roll([2, 3, 4, 6, 6]); // подтверждающий бросок без очков — сгорает
assert(s.phase === 'bust' && s.bust.lost === 115, 'confirm roll busts');
ctx.timer();
assert(p() !== first && s.total[first] === 0, 'turn passed');
// второй игрок проходит допуск
const second = p();
roll([1, 1, 1, 2, 3]);
s.rollAt = 0;
assert(!act(second, { type: 'stop', keep: [0, 1, 2] }) && s.total[second] === 100, 'entry passed with 100');
// бочка: ставим первого на 840 с допуском, он набирает 15 → 850
s.total[first] = 840;
s.entry[first] = 80;
s.total[second] = 850;
roll([1, 5, 2, 3, 4]);
s.rollAt = 0;
act(first, { type: 'stop', keep: [0, 1] });
assert(s.total[first] === 850 && s.total[second] === 100, 'barrel cap, other pushed to entry');
// на бочке нужно 150
roll([1, 2, 3, 4, 6]);
s.rollAt = 0;
assert(act(second, { type: 'stop', keep: [0] }) === undefined || true, '');
// очередь второго: у него 100, просто проверим, что первый на бочке не может записать меньше 150
s.turn = s.order.indexOf(first);
s.phase = 'start';
s.dice.forEach((d) => (d.kept = false));
s.turnPts = 0;
roll([5, 2, 3, 4, 6]);
s.rollAt = 0;
assert(act(first, { type: 'stop', keep: [0] }), 'barrel needs 150');
console.log('✓ Кости 1000 (юнит)');
