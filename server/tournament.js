// Марафон: серия каток из разных игр с общей таблицей.
// Внутри катки каждая игра считает свои очки; в турнир идут места:
// 1-е место — 3 очка, 2-е — 2, 3-е — 1 (одинаковый счёт = одинаковое место, 0 очков в катке = 0).
const PLACE_POINTS = [3, 2, 1];

function placePoints(raw) {
  const levels = [...new Set(Object.values(raw).filter((v) => v > 0))].sort((a, b) => b - a);
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    const lvl = v > 0 ? levels.indexOf(v) : -1;
    out[id] = lvl >= 0 && lvl < PLACE_POINTS.length ? PLACE_POINTS[lvl] : 0;
  }
  return out;
}

function makeTour(plan) {
  const queue = [];
  for (const item of plan) for (let n = 1; n <= item.rounds; n++) queue.push({ type: item.type, n, of: item.rounds, settings: item.settings || {} });
  return { queue, idx: 0, phase: 'play', totals: {}, log: [], playedBy: {} };
}

// Вызывается после каждого изменения: если катка закончилась — записываем результат
function check(tour, game, GAMES, ctx) {
  if (!tour || tour.phase !== 'play' || !game) return false;
  const g = GAMES[game.type];
  if (!g.isOver(game.state)) return false;
  const raw = g.results(game.state, ctx);
  const pts = placePoints(raw);
  for (const [id, p] of Object.entries(pts)) {
    tour.totals[id] = (tour.totals[id] || 0) + p;
    tour.playedBy[id] = (tour.playedBy[id] || 0) + 1;
  }
  const item = tour.queue[tour.idx];
  tour.log.push({ type: item.type, n: item.n, raw, pts });
  tour.phase = tour.idx >= tour.queue.length - 1 ? 'done' : 'between';
  return true;
}

function publicTour(tour) {
  if (!tour) return null;
  return {
    phase: tour.phase, // play | between | done | final
    idx: tour.idx,
    queue: tour.queue.map(({ type, n, of }) => ({ type, n, of })),
    totals: tour.totals,
    log: tour.log,
  };
}

module.exports = { placePoints, makeTour, check, publicTour, PLACE_POINTS };
