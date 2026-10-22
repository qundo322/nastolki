// Загруженные аватарки. Клиент сам кадрирует фото под круг и присылает маленький квадрат
// (до ~256×256, JPEG/WebP/PNG). Храним в памяти по хешу — в комнату уходит только короткая ссылка /av/<хеш>,
// поэтому картинка не гоняется в каждом обновлении состояния.
// Сервер может перезапуститься и забыть картинки — клиент держит своё фото у себя и загружает его заново при входе.
const crypto = require('crypto');

const MAX_BYTES = 150 * 1024; // одна картинка
const MAX_COUNT = 600; // всего в памяти; самые старые вытесняются
const store = new Map(); // hash → { buf, type }

const MAGIC = [
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];

// data:image/...;base64,... → { url } или { error }
function put(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Нужна картинка JPEG, PNG или WebP' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return { error: 'Картинка слишком большая' };
  const kind = MAGIC.find((x) => x.test(buf));
  if (!kind) return { error: 'Это не похоже на картинку' };
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
  if (store.has(hash)) store.delete(hash); // освежаем позицию
  store.set(hash, { buf, type: kind.type });
  while (store.size > MAX_COUNT) store.delete(store.keys().next().value);
  return { url: '/av/' + hash };
}

const URL_RE = /^\/av\/[a-f0-9]{24}$/;
// Ссылка на аватар из клиента: только наша и только существующая
const clean = (u) => (typeof u === 'string' && URL_RE.test(u) && store.has(u.slice(4)) ? u : null);

function route(app) {
  app.get('/av/:hash', (req, res) => {
    const it = store.get(String(req.params.hash));
    if (!it) return res.status(404).end();
    res.set('Content-Type', it.type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(it.buf);
  });
}

module.exports = { put, clean, route, MAX_BYTES };
