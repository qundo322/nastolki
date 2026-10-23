// Юнит-тест «Викторины WoT»: данные, вопросы и подсчёт очков за варианты
const assert = require('assert');
const w = require('../server/games/wot');
assert.strictEqual(w.TANKS.length, 150, '150 танков');
for (const t of w.TANKS) {
  const qs = w.questions(t);
  assert(qs.length >= 5, `${t.name}: минимум 5 вопросов`);
  for (const q of qs) {
    if (q.kind === 'choice') assert(q.opts.length === 4 && q.opts[q.correct] != null && new Set(q.opts).size === 4, `${t.name}/${q.key}: 4 разных варианта`);
    else assert(Number.isFinite(q.answer), `${t.name}/${q.key}: число`);
  }
  assert(t.box && t.box.length === 4, `${t.name}: рамка картинки`);
}
// партия: 2 игрока, вопрос с вариантами
const timers = {};
const players = new Map([['a', { id: 'a', connected: true }], ['b', { id: 'b', connected: true }]]);
const ctx = { players: () => [...players.values()], room: { players }, isHost: true, setTimer: (k, ms, fn) => (timers[k] = fn), clearTimer: (k) => delete timers[k] };
const s = w.create(ctx, { rounds: 4, seconds: 20 });
let guard = 0;
while (s.q.kind !== 'choice' && guard++ < 10) { timers.wot(); timers.wot(); }
assert.strictEqual(s.q.kind, 'choice');
const ok = s.q.correct;
assert.ifError(w.action(s, 'a', { type: 'answer', v: ok }, ctx));
assert(w.action(s, 'a', { type: 'answer', v: (ok + 1) % 4 }, ctx), 'выбор окончательный');
w.action(s, 'b', { type: 'answer', v: (ok + 1) % 4 }, ctx);
assert.strictEqual(s.phase, 'reveal');
assert.strictEqual(s.res.got.a, 2, 'верно и быстрее всех: +2');
assert(!s.res.got.b, 'мимо: 0');
const v = w.view(s, 'b');
assert.strictEqual(v.q.correct, ok);
assert(v.q.img && v.q.img.tag);
console.log('✓ Викторина WoT (юнит)');
