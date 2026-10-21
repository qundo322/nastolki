/* Пиксель-аватар 16×16. 8 параметров, у каждого 10 вариантов. Фон задаёт игра (цвет команды или случайный).
   PixelAvatar.svg(av, size, bg) → строка <svg>; PixelAvatar.random() → случайный набор. */
(() => {
  const KEYS = ['s', 'h', 'hc', 'e', 'm', 'b', 'a', 'w'];
  const LABEL = { s: 'Кожа', h: 'Причёска', hc: 'Цвет волос', e: 'Цвет глаз', m: 'Рот', b: 'Борода', a: 'Аксессуар', w: 'Головной убор' };
  const COLOR_KEYS = ['s', 'hc', 'e'];
  const NAMES = {
    h: ['Лысый', 'Ёжик', 'Классика', 'Ирокез', 'Шипы', 'Каре', 'Длинные', 'Афро', 'Пучок', 'Хвост'],
    m: ['Улыбка', 'Ровно', 'Хохот', 'Ого', 'Ухмылка', 'Язык', 'Грусть', 'Зубы', 'Котик', 'Хм'],
    b: ['Нет', 'Щетина', 'Усы', 'Борода', 'Эспаньолка', 'Шкипер', 'Усы-руль', 'Длинная', 'Под губой', 'Бакенбарды'],
    a: ['Нет', 'Очки', 'Тёмные очки', 'Повязка', 'Монокль', 'Румянец', 'Серьги', 'Веснушки', 'Шрам', 'Визор'],
    w: ['Нет', 'Кепка', 'Шапка', 'Ковбойская', 'Корона', 'Повязка', 'Бандана', 'Цилиндр', 'Викинг', 'Наушники'],
  };
  const PAL = {
    s: ['#ffe0c7', '#f6c9a3', '#ecb489', '#dc9b6d', '#c98452', '#ae6a3f', '#8d522f', '#6e3d23', '#f3c6c6', '#a8d8a0'],
    hc: ['#1d1816', '#3d2a1f', '#6a4426', '#9c6431', '#d6a24a', '#f0d68b', '#c2412e', '#8a8f99', '#ecebf0', '#5c7cfa'],
    e: ['#1f1f24', '#5b3a1e', '#2f6fd6', '#2e9b65', '#7d8b97', '#8d5bd6', '#c8871f', '#d33f6a', '#1fb5c9', '#9aa6b2'],
  };
  // Фоны для одиночных игр (выбираются по игроку) и для команд
  const BG = ['#ffd166', '#ff8c69', '#ff70a6', '#b388ff', '#6aa9ff', '#4fd1c5', '#7ed957', '#d4e157', '#f4a261', '#9aa5b8'];
  const NEUTRAL = '#8b93a7';

  // осветлить (f>0) или затемнить (f<0) цвет
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const t = f < 0 ? 0 : 255, p = Math.abs(f);
    r = Math.round((t - r) * p + r);
    g = Math.round((t - g) * p + g);
    b = Math.round((t - b) * p + b);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // Причёски: [y, x1, x2]
  const HAIR = [
    [],
    [[3, 5, 10], [4, 4, 11]],
    [[2, 5, 10], [3, 4, 11], [4, 4, 11], [5, 4, 7], [5, 11, 11], [6, 4, 4], [6, 11, 11]],
    [[0, 7, 8], [1, 7, 8], [2, 7, 8], [3, 6, 9], [4, 6, 9]],
    [[1, 5, 5], [1, 8, 8], [1, 11, 11], [2, 5, 6], [2, 8, 9], [2, 10, 11], [3, 4, 11], [4, 4, 11], [5, 4, 4], [5, 11, 11]],
    [[2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 12], ...[6, 7, 8, 9, 10].flatMap((y) => [[y, 3, 4], [y, 11, 12]])],
    [[2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 5], [5, 10, 12], ...[6, 7, 8, 9, 10, 11, 12].flatMap((y) => [[y, 3, 4], [y, 11, 12]]), [13, 2, 4], [13, 11, 13], [14, 2, 4], [14, 11, 13]],
    [[0, 5, 10], [1, 3, 12], [2, 2, 13], [3, 2, 13], [4, 2, 13], [5, 2, 4], [5, 11, 13], [6, 2, 3], [6, 12, 13], [7, 2, 3], [7, 12, 13], [8, 3, 3], [8, 12, 12]],
    [[0, 6, 9], [1, 6, 9], [2, 5, 10], [3, 4, 11], [4, 4, 11], [5, 4, 4], [5, 11, 11]],
    [[2, 5, 10], [3, 4, 11], [4, 4, 11], [5, 4, 5], [5, 10, 11], [4, 12, 13], [5, 12, 13], [6, 13, 14], [7, 13, 14], [8, 13, 14], [9, 13, 13]],
  ];
  const BEARD = [
    [],
    'stubble',
    [[9, 6, 9]],
    [[8, 4, 4], [8, 11, 11], [9, 4, 11], [10, 4, 5], [10, 10, 11], [11, 4, 5], [11, 10, 11], [12, 4, 11], [13, 5, 10]],
    [[12, 6, 9], [13, 7, 8]],
    [[9, 4, 4], [9, 11, 11], [10, 4, 4], [10, 11, 11], [11, 4, 4], [11, 11, 11], [12, 4, 11], [13, 6, 9]],
    [[9, 5, 10], [10, 4, 4], [10, 11, 11]],
    [[8, 4, 4], [8, 11, 11], [9, 4, 11], [10, 4, 5], [10, 10, 11], [11, 4, 5], [11, 10, 11], [12, 4, 11], [13, 5, 10], [14, 6, 9], [15, 7, 8]],
    [[12, 7, 8]],
    [6, 7, 8, 9].flatMap((y) => [[y, 4, 4], [y, 11, 11]]),
  ];

  function draw(av, bg) {
    const R = [];
    const px = (x, y, c, o) => R.push([x, y, 1, 1, c, o]);
    const span = (y, x1, x2, c, o) => R.push([x1, y, x2 - x1 + 1, 1, c, o]);
    const spans = (list, c, o) => list.forEach(([y, a, b]) => span(y, a, b, c, o));
    const skin = PAL.s[av.s], hair = PAL.hc[av.hc], eye = PAL.e[av.e];
    const skinD = shade(skin, -0.18);
    const dark = '#3b2028';

    R.push([0, 0, 16, 16, bg]);
    // плечи и шея
    const shirt = shade(bg, -0.38);
    span(14, 3, 12, shirt);
    span(15, 2, 13, shirt);
    span(13, 6, 9, skinD);
    // голова и уши
    span(4, 5, 10, skin);
    for (let y = 5; y <= 11; y++) span(y, 4, 11, skin);
    span(12, 5, 10, skin);
    px(3, 8, skin); px(3, 9, skinD); px(12, 8, skin); px(12, 9, skinD);
    // нос
    px(7, 9, skinD); px(8, 9, skinD);
    // борода (до рта, чтобы рот был виден)
    const bd = BEARD[av.b];
    if (bd === 'stubble') spans([[10, 4, 5], [10, 10, 11], [11, 4, 11], [12, 5, 10]], hair, 0.35);
    else spans(bd, hair);
    // рот
    const M = [
      () => { px(6, 10, dark); px(9, 10, dark); span(11, 7, 8, dark); },
      () => span(11, 6, 9, dark),
      () => { span(10, 6, 9, dark); px(7, 10, '#fff'); px(8, 10, '#fff'); span(11, 7, 8, dark); },
      () => { span(10, 7, 8, dark); span(11, 7, 8, dark); },
      () => { px(9, 10, dark); span(11, 6, 8, dark); },
      () => { span(10, 6, 9, dark); span(11, 7, 8, '#e8768a'); },
      () => { span(10, 7, 8, dark); px(6, 11, dark); px(9, 11, dark); },
      () => { span(10, 6, 9, '#fff'); span(11, 6, 9, dark); },
      () => { px(6, 10, dark); px(7, 11, dark); px(8, 10, dark); px(9, 11, dark); },
      () => px(8, 11, dark),
    ];
    M[av.m]();
    // волосы, брови, глаза
    spans(HAIR[av.h], hair);
    const brow = av.h === 0 && av.b === 0 ? skinD : shade(hair, -0.1);
    span(6, 5, 6, brow); span(6, 9, 10, brow);
    px(6, 7, eye); px(6, 8, eye); px(9, 7, eye); px(9, 8, eye);
    px(5, 8, '#ffffff', 0.85); px(10, 8, '#ffffff', 0.85);
    // аксессуар
    const ink = '#1a1a1f', gold = '#e8b830';
    const frame = (x, c) => { span(6, x, x + 2, c); span(9, x, x + 2, c); px(x, 7, c); px(x, 8, c); px(x + 2, 7, c); px(x + 2, 8, c); };
    const A = [
      () => {},
      () => { frame(5, ink); frame(8, ink); px(4, 7, ink); px(11, 7, ink); },
      () => { span(7, 4, 11, ink); span(8, 5, 7, ink); span(8, 8, 10, ink); px(5, 7, '#6b7280'); px(8, 7, '#6b7280'); },
      () => { span(6, 4, 11, ink); span(7, 8, 10, ink); span(8, 8, 10, ink); px(9, 9, ink); },
      () => { frame(8, gold); px(10, 10, gold); px(11, 11, gold); px(11, 12, gold); },
      () => { span(9, 4, 5, '#f28b9b', 0.8); span(9, 10, 11, '#f28b9b', 0.8); },
      () => { px(3, 10, gold); px(12, 10, gold); },
      () => { const f = shade(skin, -0.42); px(5, 9, f); px(10, 9, f); px(4, 10, f); px(11, 10, f); px(6, 9, f, 0.7); },
      () => { const c = '#9b2f3a'; px(10, 9, c); px(10, 10, c); px(11, 10, c); px(9, 9, c, 0.6); },
      () => { span(7, 4, 11, '#38e1f2', 0.9); span(8, 4, 11, '#1aa7c4', 0.9); },
    ];
    A[av.a]();
    // головной убор
    const W = [
      () => {},
      () => { const c = '#d64545'; span(1, 5, 10, c); span(2, 4, 11, c); span(3, 4, 11, c); span(4, 4, 14, shade(c, -0.3)); px(7, 1, shade(c, 0.3)); },
      () => { const c = '#2bb3a3'; px(7, 0, '#fff'); px(8, 0, '#fff'); span(1, 5, 10, c); span(2, 4, 11, c); span(3, 4, 11, c); span(4, 4, 11, shade(c, 0.35)); },
      () => { const c = '#8a5a2b'; span(0, 6, 9, c); span(1, 5, 10, c); span(2, 5, 10, shade(c, -0.45)); span(3, 1, 14, shade(c, -0.15)); },
      () => { const c = gold; px(5, 1, c); px(7, 1, c); px(8, 1, c); px(10, 1, c); span(2, 5, 10, c); span(3, 5, 10, c); px(7, 3, '#d33f6a'); px(8, 3, '#d33f6a'); px(5, 3, '#2f6fd6'); px(10, 3, '#2f6fd6'); },
      () => { const c = '#e04848'; span(5, 4, 11, c); px(12, 5, c); px(13, 6, c); },
      () => { const c = '#5b3fa6'; span(2, 5, 10, c); span(3, 4, 11, c); span(4, 4, 11, c); span(4, 12, 13, c); px(13, 5, c); px(6, 3, '#fff'); px(9, 3, '#fff'); },
      () => { const c = '#1d1b22'; for (let y = 0; y <= 3; y++) span(y, 5, 10, c); span(3, 5, 10, '#c0392b'); span(4, 3, 12, c); },
      () => { const c = '#9aa1ab', h = '#f1e6c8'; span(2, 5, 10, c); span(3, 4, 11, c); span(4, 4, 11, shade(c, -0.25)); px(2, 1, h); span(2, 2, 3, h); px(3, 3, h); px(13, 1, h); span(2, 12, 13, h); px(12, 3, h); },
      () => { const c = '#2a2933', k = '#ff70a6'; span(1, 5, 10, c); px(4, 2, c); px(11, 2, c); px(3, 3, c); px(12, 3, c); for (let y = 4; y <= 5; y++) { px(3, y, c); px(12, y, c); } for (let y = 6; y <= 10; y++) { span(y, 2, 3, k); span(y, 12, 13, k); } },
    ];
    W[av.w]();
    return R;
  }

  const cache = new Map();
  function svg(av, size = 32, bg = NEUTRAL) {
    if (!av) return '';
    const key = KEYS.map((k) => av[k]).join('') + ':' + size + bg;
    if (cache.has(key)) return cache.get(key);
    const rects = draw(av, bg)
      .map(([x, y, w, h, c, o]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"${o != null ? ` fill-opacity="${o}"` : ''}/>`)
      .join('');
    const out = `<svg class="px" viewBox="0 0 16 16" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
    if (cache.size > 600) cache.clear();
    cache.set(key, out);
    return out;
  }
  const random = () => Object.fromEntries(KEYS.map((k) => [k, Math.floor(Math.random() * 10)]));
  const valid = (a) => a && KEYS.every((k) => Number.isInteger(a[k]) && a[k] >= 0 && a[k] <= 9);

  // Базовый вид для превью вариантов в конструкторе: меняется только сам вариант
  const BASE = { s: 1, h: 2, hc: 1, e: 2, m: 0, b: 0, a: 0, w: 0 };
  window.PixelAvatar = { KEYS, LABEL, NAMES, PAL, BG, NEUTRAL, BASE, COLOR_KEYS, svg, random, valid };
})();
