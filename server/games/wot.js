const { build } = require('./quiz');
const { shuffle, Deck, countLabel } = require('../util');
const RAW = require('../wot_data');

// «Викторина WoT»: вопросы по 250 танкам World of Tanks — числа (как в обычной викторине) и варианты А–Г.
// «57 mm ZiS-4 (T-34)» → «57 mm ZiS-4»: служебные пометки в скобках не нужны
const gunName = (g) => g.replace(/\s*\([^)]*\)\s*$/, '');
const TANKS = RAW.map(([tag, name, nat, type, tier, hp, fwd, back, view, gun, ammo, pen, dmg, cal, power, front, crew, price, clip, kind, box]) => ({ tag, name, nat, type, tier, hp, fwd, back, view, gun: gunName(gun), ammo, pen, dmg, cal, power, front, crew, price, clip, kind, box }));

const NATION = { ussr: 'СССР', germany: 'Германия', usa: 'США', uk: 'Великобритания', france: 'Франция', china: 'Китай', japan: 'Япония', czech: 'Чехословакия', sweden: 'Швеция', poland: 'Польша', italy: 'Италия' };
const TYPE = { LT: 'Лёгкий танк', MT: 'Средний танк', HT: 'Тяжёлый танк', TD: 'ПТ-САУ', SPG: 'САУ' };
const TYPE_SHORT = { LT: 'ЛТ', MT: 'СТ', HT: 'ТТ', TD: 'ПТ-САУ', SPG: 'САУ' };
const SHELL_G = { ARMOR_PIERCING: 'бронебойного', ARMOR_PIERCING_CR: 'подкалиберного', HIGH_EXPLOSIVE: 'фугасного', HOLLOW_CHARGE: 'кумулятивного' };
const SHELL = { ARMOR_PIERCING: 'бронебойным', ARMOR_PIERCING_CR: 'подкалиберным', HIGH_EXPLOSIVE: 'фугасным', HOLLOW_CHARGE: 'кумулятивным' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

const who = (t) => `${t.name}`;
const label = (t) => `${TYPE_SHORT[t.type]} ${ROMAN[t.tier]} · ${NATION[t.nat]}`;

// Варианты ответа: правильный + 3 других, перемешаны
function options(right, pool) {
  const wrong = shuffle([...new Set(pool.filter((x) => x !== right))]).slice(0, 3);
  const opts = shuffle([right, ...wrong]);
  return { opts, correct: opts.indexOf(right) };
}
// Похожие танки: тот же тип, уровень ±1 (если мало — любой тип)
function similar(t, n = 12) {
  let pool = TANKS.filter((x) => x !== t && x.type === t.type && Math.abs(x.tier - t.tier) <= 1);
  if (pool.length < 3) pool = TANKS.filter((x) => x !== t && Math.abs(x.tier - t.tier) <= 1);
  return shuffle(pool).slice(0, n);
}

// Все вопросы по танку (у каждого танка их 12–16)
function questions(t) {
  const Q = [];
  const num = (key, text, answer, unit) => answer != null && Q.push({ key, kind: 'num', text, answer, unit });
  const ch = (key, text, right, pool) => {
    const o = options(right, pool);
    if (o.opts.length === 4) Q.push({ key, kind: 'choice', text, ...o });
  };
  num('tier', `Какого уровня ${who(t)}?`, t.tier, 'уровень');
  num('hp', `Сколько прочности у ${who(t)} с топовой башней?`, t.hp, 'HP');
  num('fwd', `Максимальная скорость ${who(t)} вперёд?`, t.fwd, 'км/ч');
  num('back', `Максимальная скорость ${who(t)} задним ходом?`, t.back, 'км/ч');
  num('view', `Обзор ${who(t)} с топовой башней?`, t.view, 'м');
  num('dmg', `Разовый урон ${SHELL[t.kind] || 'основным'} снарядом у ${who(t)} с орудием ${t.gun}?`, t.dmg, 'урона');
  num('pen', `Бронепробитие ${SHELL_G[t.kind] || 'основного'} снаряда у ${who(t)} с орудием ${t.gun}?`, t.pen, 'мм');
  num('cal', `Калибр топового орудия ${who(t)}?`, t.cal, 'мм');
  num('ammo', `Сколько снарядов в боекомплекте ${who(t)} с орудием ${t.gun}?`, t.ammo, 'снарядов');
  num('power', `Мощность топового двигателя ${who(t)}?`, t.power, 'л. с.');
  num('front', `Толщина брони лба корпуса ${who(t)}?`, t.front, 'мм');
  if (t.price > 1000) num('price', `Сколько кредитов стоит ${who(t)} в магазине?`, t.price, 'кредитов');
  if (t.clip) num('clip', `Сколько снарядов в барабане у ${who(t)} с орудием ${t.gun}?`, t.clip, 'снарядов');
  ch('nat', `Какой нации ${who(t)}?`, NATION[t.nat], Object.values(NATION));
  ch('type', `К какому классу относится ${who(t)}?`, TYPE[t.type], Object.values(TYPE));
  ch('crew', `Сколько человек в экипаже ${who(t)}?`, `${t.crew}`, ['2', '3', '4', '5', '6', '7'].filter((x) => Math.abs(+x - t.crew) <= 3));
  ch('photo', `Что это за машина? (${label(t)})`, t.name, similar(t).map((x) => x.name));
  ch('gun', `Какое орудие стоит в топе у ${who(t)}?`, t.gun, similar(t, 20).map((x) => x.gun));
  return Q;
}
const TOTAL = TANKS.reduce((n, t) => n + questions(t).length, 0);

function draw(s) {
  if (!s.tankDeck) s.tankDeck = new Deck(TANKS.map((_, i) => i));
  if (!s.used) s.used = {};
  const ti = s.tankDeck.draw();
  const t = TANKS[ti];
  // не повторяем один вопрос про танк; числа и варианты А–Г чередуются
  const all = questions(t).filter((q) => !(s.used[ti] || []).includes(q.key));
  const wantChoice = (s.round || 0) % 2 === 0;
  const pool = all.filter((q) => (q.kind === 'choice') === wantChoice);
  const q = (pool.length ? shuffle(pool) : shuffle(all.length ? all : questions(t)))[0];
  (s.used[ti] = s.used[ti] || []).push(q.key);
  return { ...q, cat: q.key === 'photo' ? 'Угадай танк' : `${t.name} · ${label(t)}`, img: { tag: t.tag, box: t.box, hide: q.key === 'photo' } };
}

const meta = {
  title: 'Викторина WoT',
  emoji: '🪖',
  players: '2–20',
  content: `${TANKS.length} танков · ${countLabel(TOTAL, 'вопрос', 'вопроса', 'вопросов')}`,
  short: 'Вопросы по World of Tanks: прочность, урон, скорость, нация и «что за танк на картинке». Ответ — число или вариант А–Г.',
  rules: [
    'Каждый раунд — вопрос про один танк из World of Tanks, с его картинкой из танкопедии.',
    'Если ответ — число (урон, прочность, скорость), пишите своё. Ближе всех +1, точно в цель — ещё +1.',
    'Если есть варианты А–Г — выбирайте один, поменять нельзя. Верно — +1, самый быстрый из верных — ещё +1.',
    'Характеристики — из файлов игры для топовой комплектации, без экипажа и оборудования.',
    'Побеждает тот, у кого больше всего очков после последнего вопроса.',
  ],
  restartActions: ['restart'],
  settings: [
    { key: 'rounds', label: 'Вопросов', type: 'select', options: [10, 15, 20, 30], default: 15 },
    { key: 'seconds', label: 'Секунд на ответ', type: 'select', options: [20, 30, 45, 60], default: 30 },
  ],
};

module.exports = { ...build({ meta, draw, name: 'Викторины WoT', timerKey: 'wot' }), TANKS, questions };
