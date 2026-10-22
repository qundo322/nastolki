const crypto = require('crypto');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pick = (arr) => arr[crypto.randomInt(arr.length)];

// Нормализация для сравнения слов: регистр, ё→е, лишние символы
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-яіїєґ0-9]/gi, '');

// Колода, которая не повторяет слова, пока не закончится
class Deck {
  constructor(items) {
    this.items = items;
    this.pile = shuffle(items);
  }
  draw() {
    if (!this.pile.length) this.pile = shuffle(this.items);
    return this.pile.pop();
  }
  toJSON() {
    return undefined;
  }
}

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

// Слова, которые ввели сами игроки (через запятую или с новой строки)
const customWords = (text) =>
  [...new Set(String(text || '').split(/[,\n;]/).map((w) => w.trim()).filter((w) => w && w.length <= 40))];

// «1 088 слов», «500 вопросов» — подпись объёма для карточки игры
function countLabel(n, one, few, many) {
  const f = n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')} ${f}`;
}

module.exports = { shuffle, pick, norm, Deck, clampInt, customWords, countLabel };
