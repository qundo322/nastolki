// «Ждём игроков»: если игроков пока мало, игра всё равно открывается — в режиме ожидания.
// Все, кто заходит по ссылке, сразу оказываются в игре. Проверка на минимум — когда хост жмёт «Начать».
// Обёртка хранит настоящее состояние игры в s.inner и просто передаёт ему все вызовы.
function wrap(g) {
  const w = {
    meta: g.meta,
    create(ctx, settings) {
      const r = g.create(ctx, settings || {});
      if (typeof r === 'string') return { waiting: true, settings: settings || {}, need: r, inner: null };
      return { waiting: false, inner: r };
    },
    action(s, pid, msg, ctx) {
      if (s.inner) return g.action(s.inner, pid, msg, ctx);
      if (msg.type === 'begin') {
        if (!ctx.isHost) return 'Начинает хост';
        const r = g.create(ctx, s.settings);
        if (typeof r === 'string') {
          s.need = r;
          return r; // ошибка — только при старте
        }
        s.inner = r;
        s.waiting = false;
        return;
      }
      return 'Ждём, пока хост начнёт игру';
    },
    view(s, pid, ctx) {
      return s.inner ? g.view(s.inner, pid, ctx) : { waiting: true, need: s.need };
    },
    onLeave: (s, pid, ctx) => s.inner && g.onLeave && g.onLeave(s.inner, pid, ctx),
    isOver: (s) => !!s.inner && g.isOver(s.inner),
    results: (s, ctx) => (s.inner ? g.results(s.inner, ctx) : {}),
  };
  if (g.onPresence) w.onPresence = (s, ctx) => s.inner && g.onPresence(s.inner, ctx);
  if (g.pause) w.pause = (s, ctx, why) => s.inner && g.pause(s.inner, ctx, why);
  if (g.resume) w.resume = (s, ctx, why) => s.inner && g.resume(s.inner, ctx, why);
  if (g.stats) w.stats = (s) => (s.inner ? g.stats(s.inner) : {});
  return w;
}
// Настоящее состояние игры (для подсказок в демо и т. п.)
const inner = (s) => (s && 'inner' in s ? s.inner : s);

module.exports = { wrap, inner };
