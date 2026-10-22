// Общее радио комнаты: у всех играет одно и то же.
// Сейчас играет `cur`; игроки добавляют треки в очередь `queue` и могут убрать свои, хост правит всю очередь.
// Лофи-трансляция по умолчанию — «фон»: первый добавленный трек включается сразу, не дожидаясь её конца.
const DEFAULT = { vid: 'rFZHOHl-L8A', title: 'Лофи-радио', live: true };
const MAX_QUEUE = 50;

const ytId = (url) => {
  const s = String(url || '').trim();
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
};

let seq = 0;
const nid = () => (Date.now().toString(36) + (seq++).toString(36)).slice(-10);

function make() {
  return { cur: { id: nid(), ...DEFAULT, by: null, startedAt: Date.now() }, queue: [] };
}
function getRadio(room) {
  return room.radio || (room.radio = make());
}
function play(r, item) {
  r.cur = { id: nid(), vid: item.vid, title: item.title || 'Трек', live: !!item.live, by: item.by || null, startedAt: Date.now(), tried: item.tried };
}
function next(r) {
  const item = r.queue.shift();
  if (item) play(r, item);
  else play(r, DEFAULT);
}

// op: add | now | skip | ended | remove | move | title
function handle(room, pid, msg, isHost) {
  const r = getRadio(room);
  const op = msg && msg.op;
  if (op === 'add' || op === 'now') {
    const vid = ytId(msg.url);
    if (!vid) return 'Нужна ссылка на YouTube';
    const item = { qid: nid(), vid, title: String(msg.title || '').slice(0, 120) || 'Трек', by: pid, live: false };
    if (op === 'now') {
      if (!isHost) return 'Включить сразу может только хост — добавьте в очередь';
      play(r, item);
      return;
    }
    if (r.queue.length >= MAX_QUEUE) return 'Очередь заполнена';
    if (r.queue.some((x) => x.vid === vid) || r.cur.vid === vid) return 'Этот трек уже в очереди';
    r.queue.push(item);
    if (r.cur.live && r.cur.vid === DEFAULT.vid) next(r); // фон-лофи уступает первому треку
    return;
  }
  if (op === 'ended') {
    // первый, кто сообщил о конце текущего трека, переключает всех
    if (msg.id !== r.cur.id || r.cur.live) return;
    if (Date.now() - r.cur.startedAt < 5000) return;
    next(r);
    return;
  }
  if (op === 'broken') {
    if (msg.id !== r.cur.id) return;
    next(r);
    return;
  }
  if (op === 'title') {
    // название приходит от плеера у клиента — запоминаем, если ещё не знали
    const t = String(msg.title || '').slice(0, 120);
    if (!t) return;
    if (r.cur.id === msg.id && (!r.cur.title || r.cur.title === 'Трек')) r.cur.title = t;
    return;
  }
  if (op === 'remove') {
    // убрать трек: хост — любой, игрок — только свой
    const it = r.queue.find((x) => x.qid === msg.qid);
    if (!it) return;
    if (!isHost && it.by !== pid) return 'Убрать можно только свой трек';
    r.queue = r.queue.filter((x) => x.qid !== msg.qid);
    return;
  }
  if (!isHost) return 'Только хост может управлять очередью';
  if (op === 'skip') return next(r);
  if (op === 'move') {
    const i = r.queue.findIndex((x) => x.qid === msg.qid);
    const j = i + (Number(msg.d) < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= r.queue.length) return;
    [r.queue[i], r.queue[j]] = [r.queue[j], r.queue[i]];
    return;
  }
  if (op === 'moveTo') {
    // Перетаскивание: поставить трек на позицию to
    const i = r.queue.findIndex((x) => x.qid === msg.qid);
    const to = Math.max(0, Math.min(r.queue.length - 1, Number(msg.to) | 0));
    if (i < 0 || i === to) return;
    const [item] = r.queue.splice(i, 1);
    r.queue.splice(to, 0, item);
    return;
  }
  if (op === 'lofi') {
    play(r, DEFAULT);
    return;
  }
  return 'Неизвестная команда радио';
}

function view(room) {
  const r = getRadio(room);
  return { cur: { id: r.cur.id, vid: r.cur.vid, title: r.cur.title, live: r.cur.live, by: r.cur.by, startedAt: r.cur.startedAt }, queue: r.queue.map(({ qid, vid, title, by }) => ({ qid, vid, title, by })) };
}

// Подтянуть название трека с YouTube (только на сервере, без ключей)
async function fetchTitle(vid) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.title ? String(j.title).slice(0, 120) : null;
  } catch {
    return null;
  }
}

// Треки без названия (сервер подтянет его с YouTube)
function untitled(room) {
  const r = getRadio(room);
  return [r.cur, ...r.queue].filter((x) => !x.live && (!x.title || x.title === 'Трек') && !x.tried);
}

// ---- Spotify: сам Spotify у всех синхронно не сыграть (без премиума — только 30-секундные превью),
// поэтому по ссылке Spotify узнаём «исполнитель — трек» и ищем этот же трек на YouTube.
const spotifyId = (url) => {
  const m = String(url || '').match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/) || String(url || '').match(/^spotify:track:([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
};
async function get(url, ms = 6000, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.8,ru;q=0.6', ...headers } });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
async function resolveSpotify(url) {
  const id = spotifyId(url);
  if (!id) return null;
  let title = null;
  let artist = null;
  const oe = await get(`https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/track/' + id)}`);
  try {
    title = oe && JSON.parse(oe).title;
  } catch {}
  const embed = await get(`https://open.spotify.com/embed/track/${id}`);
  if (embed) {
    const a = embed.match(/"artists":\[\{"name":"([^"]+)"/) || embed.match(/"subtitle":"([^"]+)"/);
    if (a) artist = JSON.parse('"' + a[1] + '"');
    if (!title) {
      const tt = embed.match(/"name":"([^"]+)","uri":"spotify:track:/);
      if (tt) title = JSON.parse('"' + tt[1] + '"');
    }
  }
  if (!title) return null;
  const q = `${artist ? artist + ' - ' : ''}${title}`;
  // поиск на YouTube без ключа: первая выдача; куки согласия — чтобы из Европы не уводило на страницу cookie
  const html = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' audio')}&hl=en`, 7000, { Cookie: 'CONSENT=YES+cb; SOCS=CAI' });
  const m = html && (html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/));
  if (!m) return null;
  return { vid: m[1], title: q.slice(0, 120) };
}

module.exports = { handle, view, get: getRadio, ytId, fetchTitle, untitled, DEFAULT, spotifyId, resolveSpotify };
