/* Клиент сборника настолок. Чистый JS, без сборки. Зависит от js/icons.js и js/avatar.js. */
(() => {
  const $app = document.getElementById('app');
  const LS = {
    get: (k, d) => {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : v;
      } catch {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  let token = LS.get('pg_token', '');
  if (!token) {
    token = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    LS.set('pg_token', token);
  }
  // Своё фото (уже обрезанное под круг) хранится у игрока — сервер может его забыть после перезапуска
  const myPhoto = () => LS.get('pg_photo', '') || null;

  const socket = io({ transports: ['websocket', 'polling'] });
  let S = null; // последнее состояние от сервера
  let GAMES = [];
  let offset = 0; // serverNow - clientNow
  let connected = false;
  const ui = {
    crop: null, // кадрирование загруженного фото: {src, w, h, z, x, y}
    ask: null, // своё окно подтверждения вместо браузерного confirm()
    meEdit: false, // окно «Мой профиль» в комнате
    selected: null,
    settings: {},
    showRules: false,
    gs: null, // меню подарков: { step: 'list' | 'to' | 'ok', id, to, busy }
    menu: null, // открытое всплывающее меню: 'theme' | 'p:<pid>'
    hideCard: false,
    cnSlots: null, // [{id, v}] — силы слов в подсказке капитана
    cnEdit: false, // капитан исправляет подсказку
    mode: 'single',
    mOrder: ['codenames', 'quiz', 'majority', 'spyfall', 'alias', 'whoami', 'justone', 'dice', 'poker'],
    mOn: { codenames: true, quiz: true, majority: true, spyfall: true },
    mRounds: { codenames: 2, quiz: 1, majority: 1, spyfall: 1, alias: 1, whoami: 1, justone: 1, dice: 1, poker: 1 },
    mOpen: {},
    showTable: false,
    ctlOpen: LS.get('pg_ctl', '') === '1',
  };

  // ---------- тема: тёмная / светлая / чёрная (OLED) ----------
  const THEMES = [
    { id: 'dark', name: 'Тёмная', icon: 'moon' },
    { id: 'light', name: 'Светлая', icon: 'sun' },
    { id: 'oled', name: 'Чёрная (OLED)', icon: 'oled' },
  ];
  const theme = () => document.documentElement.getAttribute('data-theme') || 'dark';
  if (!THEMES.some((t) => t.id === document.documentElement.getAttribute('data-theme'))) {
    const saved = LS.get('pg_theme', '');
    document.documentElement.setAttribute(
      'data-theme',
      THEMES.some((t) => t.id === saved) ? saved : window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    );
  }
  // Настройки вида: свечение хода и размер слов на карточках Коднеймс (у каждого свои)
  const VIEW = {
    // Сила свечения хода, 0–100 (фейдер). 0 — выкл (по умолчанию, предложим при старте партии).
    // Прежние «Слабое / Среднее / Сильное» = 20 / 30 / 50; новый максимум примерно вдвое сильнее.
    glow: (() => {
      const v = LS.get('pg_glow_v', '');
      if (v !== '') return Math.max(0, Math.min(100, Number(v) || 0));
      const lvl = Number(LS.get('pg_glow_lvl', '')) || (LS.get('pg_glow', '0') === '1' ? 2 : 0);
      return [0, 20, 30, 50][lvl] || 0;
    })(),
    fs: Number(LS.get('pg_cnfs', '36')) || 36,
    // Наклон карточек Коднеймс под курсором, 0–100 (50 — по умолчанию, ≈10°)
    tilt: (() => {
      const v = LS.get('pg_tilt', '');
      return v === '' ? 50 : Math.max(0, Math.min(100, Number(v) || 0));
    })(),
    // Масштаб интерфейса: ползунок 0–100 → 85–130 %, по умолчанию 100 %
    scale: (() => {
      const v = LS.get('pg_scale', '');
      return v === '' ? 33 : Math.max(0, Math.min(100, Number(v) || 0));
    })(),
    // Переключатели доступности и удобства (true/false), хранятся по отдельности
    calm: LS.get('pg_calm', '') === '1', // меньше анимаций
    cb: LS.get('pg_cb', '') === '1', // значки цветов в Коднеймс (для дальтоников)
    bigAlias: LS.get('pg_bigAlias', '') === '1', // крупное слово в Элиасе
    bigRole: LS.get('pg_bigRole', '') === '1', // крупная карточка роли в Шпионе
    bigQ: LS.get('pg_bigQ', '') === '1', // крупный вопрос в Викторине и «Ответе большинства»
    bigWho: LS.get('pg_bigWho', '') === '1', // ещё крупнее карточки в «Кто я?»
  };
  const scalePct = (v) => Math.round(85 + v * 0.45);
  const VIEW_TOGGLES = ['calm', 'cb', 'bigAlias', 'bigRole', 'bigQ', 'bigWho'];
  const FS_OPTS = [24, 30, 36, 42];
  function applyView() {
    const v = VIEW.glow;
    const st = document.documentElement.style;
    st.setProperty('--ui-zoom', String(scalePct(VIEW.scale) / 100));
    for (const k of VIEW_TOGGLES) document.documentElement.classList.toggle('v-' + k, !!VIEW[k]);
    document.documentElement.dataset.glow = v ? 'on' : 'off';
    if (v) {
      st.setProperty('--glow-k', String(Math.min(1, 0.35 + v / 80))); // яркость пульса
      st.setProperty('--glow-a', Math.round(10 + v * 0.9) + '%'); // насыщенность цвета
      st.setProperty('--glow-s', String(0.85 + v / 100)); // размер пятна
    }
    document.documentElement.style.setProperty('--cn-fs', String(VIEW.fs));
    window.CN_TILT = (VIEW.tilt / 100) * 20; // градусов, читает fx.js
  }
  applyView();
  // Простые ползунки настроек вида: подпись, значение, тонкая дорожка с круглой ручкой
  const glowLabel = (v) => (v ? (v <= 25 ? 'слабое' : v <= 45 ? 'среднее' : v <= 70 ? 'сильное' : 'максимум') : 'выкл');
  const tiltLabel = (v) => (v ? (v <= 30 ? 'лёгкий' : v <= 60 ? 'средний' : v <= 85 ? 'сильный' : 'максимум') : 'выкл');
  const slider = (key, title, v, label) => `<div class="sl" style="--v:${v}%">
      <div class="sl-top"><span>${title}</span><b data-sl-label="${key}">${label(v)}</b></div>
      <input type="range" min="0" max="100" step="1" value="${v}" data-sl="${key}" aria-label="${title}" />
    </div>`;
  const glowFader = () => slider('glow', 'Свечение хода', VIEW.glow, glowLabel);
  const tiltFader = () => slider('tilt', 'Наклон карточек', VIEW.tilt, tiltLabel);
  // Переключатель темы на три положения: светлая · тёмная · OLED
  const TT = [
    { id: 'light', name: 'Светлая тема' },
    { id: 'dark', name: 'Тёмная тема' },
    { id: 'oled', name: 'Чёрная тема для OLED' },
  ];
  const themeToggle = () => `<div class="tt" data-t="${theme()}" role="radiogroup" aria-label="Тема">
      <span class="tt-sky" aria-hidden="true"><i class="tt-day"></i><i class="tt-night"></i><i class="tt-black"></i></span>
      <span class="tt-knob" aria-hidden="true"><i></i><i></i><i></i></span>
      ${TT.map((t, i) => `<button type="button" class="tt-hit h${i}" data-act="set-theme" data-t="${t.id}" role="radio" aria-checked="${theme() === t.id}" title="${t.name}" aria-label="${t.name}"></button>`).join('')}
    </div>`;
  // Меню «Вид»: свечение хода и размер слов
  // Переключатель-«тумблер» для настроек вида
  const vtog = (k, title, sub) => `<button type="button" class="vt ${VIEW[k] ? 'on' : ''}" data-act="view-tog" data-k="${k}" role="switch" aria-checked="${!!VIEW[k]}"><span class="vt-t"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span><i class="vt-sw"></i></button>`;
  // Меню «Вид»: общие настройки + раздел каждой игры; раздел текущей игры подсвечен
  const viewMenu = () => {
    const cur = S?.game?.type || null;
    const sec = (ids, title, body) => {
      const now = ids.includes(cur);
      return `<section class="vp-sec ${now ? 'now' : ''}"><div class="vp-sh">${ids.length === 1 ? gIcon(ids[0], 15) : ic('sparkles', 15)}<b>${title}</b>${now ? '<span class="vp-now">сейчас</span>' : ''}</div>${body}</section>`;
    };
    // текущая игра — первым разделом после общих
    const games = [
      [['codenames'], 'Коднеймс', `${tiltFader()}<div class="vp-h">Размер слов на карточках</div><div class="vp-seg">${FS_OPTS.map((n) => `<button class="${VIEW.fs === n ? 'on' : ''}" data-act="view-fs" data-n="${n}" style="font-size:${10 + (n - 24) / 3}px">Аа</button>`).join('')}</div>${vtog('cb', 'Значки цветов', 'для дальтоников: ▲ красные, ● синие, ✕ убийца')}`],
      [['codenames', 'justone'], 'Свечение хода', `${glowFader()}<p class="vp-note">Мерцание по краю экрана: в Коднеймс — цветом команды, в «Намёк понял» — сверху</p>`],
      [['alias'], 'Элиас', vtog('bigAlias', 'Крупное слово', 'легче читать объясняющему издалека')],
      [['spyfall'], 'Шпион', vtog('bigRole', 'Крупная карточка роли', 'локация и роль крупным шрифтом')],
      [['whoami'], 'Кто я?', vtog('bigWho', 'Ещё крупнее карточки', 'аватары и персонажи на весь экран')],
      [['quiz', 'majority'], 'Викторина и «Ответ большинства»', vtog('bigQ', 'Крупный вопрос', 'вопрос и поле ответа крупнее')],
    ].sort((a, b) => b[0].includes(cur) - a[0].includes(cur));
    return `<div class="menu-wrap" data-pop>
      <button class="btn sm ghost view-btn" data-act="menu" data-menu="theme" title="Настройки вида и доступности">${ic('sliders', 17)}<span class="hide-m">Вид</span></button>
      ${
        ui.menu === 'theme'
          ? `<div class="pop right view-pop ${ui.popAnim ? 'anim' : ''}">
              <div class="vp-title">${ic('sliders', 16)} Настройки вида</div>
              ${sec([], 'Везде', `${slider('scale', 'Размер интерфейса', VIEW.scale, (v) => scalePct(v) + '%')}${vtog('calm', 'Меньше анимаций', 'без вращений, наклонов и фоновых волн')}`)}
              ${games.filter(([ids]) => !cur || ids.includes(cur)).map(([ids, t, body]) => sec(ids, t, body)).join('')}
            </div>`
          : ''
      }
    </div>`;
  };
  // Ползунки двигаем без перерисовки — эффект виден сразу
  document.addEventListener('input', (e) => {
    const key = e.target.dataset && e.target.dataset.sl;
    if (!key) return;
    const v = Number(e.target.value) || 0;
    VIEW[key] = v;
    LS.set({ glow: 'pg_glow_v', tilt: 'pg_tilt', scale: 'pg_scale' }[key], String(v));
    applyView();
    const label = { glow: glowLabel, tilt: tiltLabel, scale: (x) => scalePct(x) + '%' }[key];
    document.querySelectorAll(`[data-sl="${key}"]`).forEach((r) => {
      if (r !== e.target) r.value = v;
      r.closest('.sl')?.style.setProperty('--v', v + '%');
    });
    document.querySelectorAll(`[data-sl-label="${key}"]`).forEach((l) => (l.textContent = label(v)));
  });

  // ---------- громкость звуков интерфейса ----------
  const sfxMenu = () => `<div class="menu-wrap" data-pop>
      <button class="btn sm ghost icon-btn" data-act="menu" data-menu="sfx" title="Звуки интерфейса">${ic(Sound.vol ? 'volume' : 'mute')}</button>
      ${
        ui.menu === 'sfx'
          ? `<div class="pop right sfx-pop ${ui.popAnim ? 'anim' : ''}">
              <div class="ctl-h">${ic('volume', 14)} Звуки интерфейса</div>
              <div class="sfx-row"><button class="icon-x" data-act="sfx-mute" title="${Sound.vol ? 'Выключить' : 'Включить'}">${ic(Sound.vol ? 'volume' : 'mute', 18)}</button>
              <input type="range" min="0" max="100" step="1" value="${Sound.vol}" data-sfx aria-label="Громкость звуков"/><b class="sfx-v">${Sound.vol}</b></div>
            </div>`
          : ''
      }
    </div>`;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const player = (pid) => S?.room.players.find((p) => p.id === pid);
  const nm = (pid) => esc(player(pid)?.name || '—');
  const isHost = () => S && S.room.hostId === S.me;
  const tour = () => S?.room.tour || null;
  const now = () => Date.now() + offset;
  const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

  // ---------- аватарки ----------
  const initials = (n) =>
    String(n || '?')
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';
  const hue = (n) => [...String(n)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  const SIZES = { xs: 18, sm: 24, md: 32, lg: 56, xl: 120 };
  // Фон аватара: цвет команды в командных играх, иначе свой (случайный, но постоянный) для каждого игрока
  const TEAM_BG = { red: '#ff6452', blue: '#4fb8ff' };
  const ALIAS_BG = ['#ff6452', '#4fb8ff', '#7ed957', '#b388ff', '#ffd166'];
  function bgFor(id) {
    const g = S?.game;
    if (id && g?.type === 'codenames') return TEAM_BG[g.team[id]] || null;
    if (id && g?.type === 'alias') {
      const i = g.teams.findIndex((t) => t.members.includes(id));
      if (i >= 0) return ALIAS_BG[i];
    }
    return null;
  }
  // ===== Подарки =====
  // place: on — прямо на аватарке (след, пятно), side — рядом в углу, crown — отдельный слот сверху
  const GIFTS = {
    kiss: { e: '💋', name: 'Поцелуй', price: 20, min: 5, place: 'on', say: (a, b) => `${a} поцеловал ${b}!`, dur: 'Поцелуй на 5 минут' },
    rose: { e: '🌹', name: 'Роза', price: 50, min: 5, place: 'side', say: (a, b) => `${a} подарил розу ${b}!`, dur: 'Роза на 5 минут' },
    beer: { e: '🍺', name: 'Пиво', price: 100, min: 10, place: 'side', say: (a, b) => `${a} угостил ${b} пивом!`, dur: 'Пиво на 10 минут' },
    slap: { e: '🥊', mark: '💢', name: 'Дать леща', price: 150, min: 5, place: 'on', say: (a, b) => `${a} отвесил леща ${b}!`, dur: 'След от леща на 5 минут' },
    whisky: { e: '🥃', name: 'Виски', price: 200, min: 10, place: 'side', say: (a, b) => `${a} налил виски для ${b}!`, dur: 'Виски на 10 минут' },
    tomato: { e: '🍅', name: 'Помидор', price: 250, min: 5, place: 'on', say: (a, b) => `${a} закидал помидорами ${b}!`, dur: 'Помидор на 5 минут' },
    poop: { e: '💩', name: 'Какашка', price: 500, min: 10, place: 'on', anon: true, say: (_a, b) => `Кто-то обгадил ${b}!`, dur: 'Какашка на 10 минут' },
    crown: { e: '👑', name: 'Корона', price: 1000, min: 15, place: 'crown', say: (a, b) => `${a} короновал ${b}!`, dur: 'Корона на 15 минут' },
    ring: { e: '💍', name: 'Предложение руки и сердца', short: 'Предложение', price: 1500, min: 15, place: 'side', say: (a, b) => `${a} сделал предложение ${b}!`, dur: 'Кольцо на 15 минут' },
  };
  const GIFT_ORDER = Object.keys(GIFTS);
  const giftsOf = (pid) => {
    const x = S?.room?.gifts?.[pid];
    if (!x) return null;
    const t = now();
    const gift = x.gift && x.gift.until > t ? x.gift : null;
    const crown = x.crown && x.crown.until > t ? x.crown : null;
    return gift || crown ? { gift, crown } : null;
  };
  // Подарок на аватарке: размер — от размера аватарки (--s), без таймеров
  function giftDeco(pid, px) {
    const x = giftsOf(pid);
    if (!x) return '';
    let h = '';
    const fresh = (slot) => (now() - slot.at < 2600 ? `fresh" style="--ge:-${Math.max(0, now() - slot.at)}ms` : '');
    if (x.gift) {
      const g = GIFTS[x.gift.id];
      if (g) {
        const inner = x.gift.id === 'tomato' ? '<i class="splat"></i>' : x.gift.id === 'slap' ? `<i class="slap-mark"></i><b>${g.mark}</b>` : g.e;
        h += `<span class="gft p-${g.place} g-${x.gift.id} ${fresh(x.gift)}" aria-hidden="true">${inner}</span>`;
      }
    }
    if (x.crown) h += `<span class="gft p-crown ${fresh(x.crown)}" aria-hidden="true">👑</span>`;
    return h;
  }

  // Аватар: своё фото или инициалы. В командных играх — кольцо цвета команды.
  // Реальное имя (если указано) показывается при наведении — см. realTip ниже.
  function avaHtml(p, size = 'sm', cls = '') {
    const px = SIZES[size] || size;
    const name = p?.name || '?';
    const team = p?.id ? bgFor(p.id) : null;
    const img = p?.avatar ? `<img src="${esc(p.avatar)}" alt="" draggable="false" decoding="sync" onerror="this.remove()">` : '';
    const real = p?.real ? ` data-real="${esc(p.real)}" data-nick="${esc(name)}"` : '';
    const ava = `<span class="ava ${size} ${cls} ${team ? 'tring' : ''}" style="--h:${hue(name)};width:${px}px;height:${px}px${typeof size === 'number' && px > 44 ? `;font-size:${Math.round(px * 0.34)}px` : ''}${team ? `;--ring:${team}` : ''}"${real}><b>${esc(initials(name))}</b>${img}</span>`;
    const deco = p?.id ? giftDeco(p.id, px) : '';
    if (!deco) return ava;
    const hit = giftsOf(p.id)?.gift;
    const shake = hit && ['slap', 'tomato'].includes(hit.id) && now() - hit.at < 1200 ? ` hit" style="--s:${px}px;--ge:-${now() - hit.at}ms` : `" style="--s:${px}px`;
    return `<span class="ava-gw${shake}">${ava}${deco}</span>`;
  }
  const pa = (pid, size = 'sm', cls = '') => avaHtml(player(pid) || { name: '?' }, size, cls);
  const who = (pid, size = 'xs') => `<span class="who-n">${pa(pid, size)}<span>${nm(pid)}</span></span>`;

  // Одно уведомление за раз: новое заменяет старое (ошибки не копятся столбиком при частых кликах).
  // Тот же текст — просто продлеваем показ и слегка «встряхиваем».
  let toastEl = null;
  let toastT1 = 0;
  let toastT2 = 0;
  function toast(msg, kind = 'err') {
    const box = document.getElementById('toasts');
    if (toastEl && toastEl.isConnected && toastEl.textContent === msg && toastEl.classList.contains(kind) && !toastEl.classList.contains('out')) {
      toastEl.classList.remove('again');
      void toastEl.offsetWidth;
      toastEl.classList.add('again');
    } else {
      box.querySelectorAll('.toast').forEach((x) => x.remove());
      toastEl = document.createElement('div');
      toastEl.className = 'toast ' + kind;
      toastEl.textContent = msg;
      box.appendChild(toastEl);
    }
    const el = toastEl;
    clearTimeout(toastT1);
    clearTimeout(toastT2);
    toastT1 = setTimeout(() => el.classList.add('out'), 2600);
    toastT2 = setTimeout(() => el.remove(), 3000);
  }

  const emit = (ev, data = {}) =>
    new Promise((res) =>
      socket.emit(ev, data, (r) => {
        if (r && r.error) {
          toast(r.error);
          Sound.play('error');
        }
        res(r || {});
      })
    );
  const act = (type, extra = {}) => emit('action', { type, ...extra });

  // ---------- общее радио комнаты (YouTube) ----------
  // Что играет — общее для всей комнаты (сервер). Слушать или нет и громкость — у каждого свои.
  const ytId = (url) => {
    const m = String(url || '').match(/(?:youtu\.be\/|[?&]v=|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/) || String(url || '').match(/^([\w-]{11})$/);
    return m ? m[1] : null;
  };
  const music = {
    on: false,
    playing: false,
    open: false,
    vol: Number(LS.get('pg_lofi_vol', '40')),
    player: null,
    ready: false,
    curId: null,
    apiReady: null,
  };
  const radio = () => S?.room?.radio || null;
  function loadYT() {
    if (music.apiReady) return music.apiReady;
    music.apiReady = new Promise((res, rej) => {
      if (window.YT && window.YT.Player) return res();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev && prev();
        res();
      };
      const sc = document.createElement('script');
      sc.src = 'https://www.youtube.com/iframe_api';
      sc.onerror = () => rej(new Error('yt'));
      document.head.appendChild(sc);
      setTimeout(() => rej(new Error('timeout')), 12000);
    });
    return music.apiReady;
  }
  const dock = document.createElement('div');
  dock.id = 'lofi';
  dock.hidden = true;
  dock.innerHTML = `<div class="lofi-head"><b class="lofi-title" data-lofi="expand" title="Показать плеер">${ic('headphones', 16)} Радио комнаты</b><span class="lofi-state muted small"></span><button class="icon-x" data-lofi="close" title="Выключить у себя">${ic('x', 16)}</button></div>
    <div class="lofi-video" aria-hidden="true"><div id="lofi-player"></div></div>
    <div class="lofi-np">
      <button type="button" class="vinyl" data-lofi="toggle" title="Пауза / играть (только у вас)" aria-label="Пауза / играть">
        <span class="vy-disc"><img class="vy-cover" alt="" draggable="false"/><i class="vy-hole"></i></span><i class="vy-shine"></i>
      </button>
      <div class="lofi-np-r">
        <div class="lofi-now"></div>
        <div class="lofi-ctl">
          <button class="btn sm icon-btn" data-lofi="toggle" title="Пауза / играть (только у вас)">${ic('pause', 16)}</button>
          <input type="range" min="0" max="100" step="1" data-lofi="vol" aria-label="Громкость"/>
          <span class="lofi-host"></span>
          <button class="btn sm ghost icon-btn" data-lofi="min" title="Свернуть">${ic('chevron', 16)}</button>
        </div>
      </div>
    </div>
    <div class="lofi-queue"></div>
    <div class="lofi-paste">
      <button type="button" class="btn lp-btn" data-lofi="paste">${ic('clip', 17)}<span><b>Вставить из буфера</b><small>ссылка YouTube или Spotify</small></span></button>
    </div>
    <form class="lofi-add" data-lofi-form hidden><span class="la-ic">${ic('link', 15)}</span><input class="inp" name="url" placeholder="Вставьте ссылку YouTube или Spotify" autocomplete="off" inputmode="url"/></form>`;
  document.body.appendChild(dock);
  dock.querySelector('[data-lofi="vol"]').value = music.vol;
  // Кнопка радио — слева снизу, открывает мини-плеер над собой
  const fab = document.createElement('button');
  fab.id = 'radio-fab';
  fab.hidden = true;
  fab.title = 'Радио комнаты — у всех играет одно и то же';
  fab.innerHTML = `<span class="rf-ic">${ic('headphones', 20)}<i class="eq"><b></b><b></b><b></b></i></span><span class="rf-t"><b>Радио</b><span class="rf-sub">включить</span></span>`;
  document.body.appendChild(fab);
  // Маленькая пауза рядом с кнопкой радио — видна, когда радио включено
  const pauseBtn = document.createElement('button');
  pauseBtn.id = 'radio-pause';
  pauseBtn.hidden = true;
  document.body.appendChild(pauseBtn);
  pauseBtn.addEventListener('click', () => {
    if (!music.player || !music.ready) return;
    music.playing ? music.player.pauseVideo() : music.player.playVideo();
  });
  fab.addEventListener('click', () => {
    Sound.play('click');
    if (!music.on) return startMusic();
    music.open = !music.open;
    syncMusicUI();
  });
  const rEmit = (op, x = {}) => emit('radio', { op, ...x });

  function syncMusicUI() {
    const r = radio();
    dock.hidden = !music.on || !r;
    dock.classList.toggle('mini', !music.open);
    dock.querySelector('.lofi-ctl [data-lofi="toggle"]').innerHTML = ic(music.playing ? 'pause' : 'play', 16);
    // Винил крутится, пока играет; обложка — превью ролика с YouTube
    const vinyl = dock.querySelector('.vinyl');
    vinyl.classList.toggle('spin', music.on && music.playing);
    const cover = dock.querySelector('.vy-cover');
    const vid = radio()?.cur?.vid;
    const src = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
    if (cover.dataset.src !== src) {
      cover.dataset.src = src;
      cover.classList.remove('ok');
      cover.onload = () => cover.classList.add('ok');
      cover.onerror = () => cover.classList.remove('ok');
      if (src) cover.src = src;
    }
    dock.querySelector('.lofi-state').textContent = music.playing ? 'играет' : 'на паузе';
    fab.hidden = !r;
    pauseBtn.hidden = !r || !music.on;
    pauseBtn.innerHTML = ic(music.playing ? 'pause' : 'play', 16);
    pauseBtn.title = music.playing ? 'Пауза (только у вас)' : 'Продолжить';
    pauseBtn.classList.toggle('paused', !music.playing);
    fab.classList.toggle('on', music.on);
    fab.classList.toggle('playing', music.on && music.playing);
    fab.classList.toggle('open', music.on && music.open);
    fab.querySelector('.rf-sub').textContent = !music.on ? 'включить' : music.playing ? (r?.cur?.live ? 'эфир' : 'играет') : 'пауза';
    if (!r) return;
    const host = isHost();
    const c = r.cur;
    dock.querySelector('.lofi-now').innerHTML = `<span class="ln-t" title="${esc(c.title)}">${esc(c.title)}</span><span class="ln-sub"><span class="ln-k">${c.live ? 'Эфир' : 'Сейчас'}</span>${c.by ? `<span class="ln-by">${pa(c.by, 'xs', 'round')}${nm(c.by)}</span>` : ''}</span>`;
    dock.querySelector('.lofi-host').innerHTML = host
      ? `<button class="btn sm ghost icon-btn" data-lofi="skip" title="Следующий трек (для всех)">${ic('skip', 16)}</button>${c.live ? '' : `<button class="btn sm ghost icon-btn" data-lofi="lofi" title="Вернуть лофи-эфир">${ic('music', 16)}</button>`}`
      : '';
    const q = r.queue;
    if (dock.querySelector('.lq-i.dragging')) return; // не перерисовывать очередь посреди перетаскивания
    // новые треки «влетают» в очередь
    const known = (music.knownQ = music.knownQ || new Set());
    const fresh = new Set(q.filter((x) => !known.has(x.qid)).map((x) => x.qid));
    q.forEach((x) => known.add(x.qid));
    dock.querySelector('.lofi-queue').innerHTML = `<div class="lq-h">Очередь <span class="muted">${q.length || 'пусто'}</span></div>${q
      .map(
        (x, i) => `<div class="lq-i ${host ? 'can-drag' : ''} ${fresh.has(x.qid) && music.qReady ? 'new' : ''} ${x.by === S.me ? 'mine' : ''}" data-q="${x.qid}">${host ? `<span class="lq-grip" data-grip title="Перетащите, чтобы поменять порядок">⋮⋮</span>` : ''}<span class="lq-n">${i + 1}</span><img class="lq-cov" src="https://i.ytimg.com/vi/${x.vid}/default.jpg" alt="" loading="lazy" onerror="this.remove()"><span class="lq-t" title="${esc(x.title)}">${esc(x.title)}</span>${x.by ? `<span class="lq-by" title="Добавил ${nm(x.by)}">${pa(x.by, 'xs', 'round')}</span>` : ''}${
          host || x.by === S.me
            ? `<span class="lq-ctl"><button class="icon-x" data-lofi="rm" data-q="${x.qid}" title="${host && x.by !== S.me ? 'Убрать из очереди' : 'Убрать свой трек'}">${ic('x', 14)}</button></span>`
            : ''
        }</div>`
      )
      .join('')}${q.length ? '' : `<div class="muted small">${c.live ? 'Добавьте трек — он включится сразу, лофи уступит.' : 'После текущего трека вернётся лофи-эфир.'}</div>`}`;
    music.qReady = true;
  }

  // Подстроиться под то, что сейчас играет в комнате
  async function syncRadio() {
    const r = radio();
    if (!r) {
      if (music.on) stopMusic();
      return;
    }
    syncMusicUI();
    if (!music.on || r.cur.id === music.curId) return;
    music.curId = r.cur.id;
    const c = r.cur;
    const at = c.live ? 0 : Math.max(0, (now() - c.startedAt) / 1000);
    try {
      await loadYT();
      if (music.player && music.ready) {
        music.player.loadVideoById({ videoId: c.vid, startSeconds: at > 3 ? at : 0 });
        return;
      }
      if (music.player) return; // ещё создаётся — onReady подхватит текущий трек
      music.player = new YT.Player('lofi-player', {
        videoId: c.vid,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(at > 3 ? at : 0) },
        events: {
          onReady: (e) => {
            music.ready = true;
            e.target.setVolume(music.vol / 2); // ползунок 0–100 = громкость 0–50: тише и точнее
            const rr = radio();
            if (rr && rr.cur.vid !== c.vid) {
              music.curId = null;
              return syncRadio();
            }
            e.target.playVideo();
          },
          onStateChange: (e) => {
            music.playing = e.data === 1 || e.data === 3;
            if (e.data === 0) rEmit('ended', { id: music.curId }); // трек доиграл — дальше по очереди у всех
            if (e.data === 1) {
              const rr = radio();
              const t = e.target.getVideoData?.().title;
              if (rr && t && rr.cur.id === music.curId && (!rr.cur.title || rr.cur.title === 'Трек')) rEmit('title', { id: music.curId, title: t });
            }
            syncMusicUI();
          },
          onError: () => {
            toast('Трек недоступен — переключаем дальше');
            rEmit('broken', { id: music.curId });
          },
        },
      });
    } catch {
      document.getElementById('lofi-player').outerHTML = `<iframe id="lofi-player" src="https://www.youtube.com/embed/${c.vid}?autoplay=1&playsinline=1&start=${Math.floor(at)}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
      music.playing = true;
      syncMusicUI();
    }
  }
  function startMusic() {
    music.on = true;
    music.open = true;
    music.curId = null;
    syncRadio();
  }
  function stopMusic() {
    try {
      music.player && music.ready && music.player.stopVideo();
    } catch {}
    const f = document.querySelector('iframe#lofi-player');
    if (f && !music.player) f.src = 'about:blank';
    music.on = false;
    music.playing = false;
    music.curId = null;
    syncMusicUI();
  }
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lofi]');
    if (!b || b.disabled) return;
    const a = b.dataset.lofi;
    if (a === 'close') stopMusic();
    else if (a === 'expand') {
      music.open = true;
      syncMusicUI();
    } else if (a === 'min') {
      music.open = false;
      syncMusicUI();
    } else if (a === 'toggle') {
      if (!music.player || !music.ready) return;
      music.playing ? music.player.pauseVideo() : music.player.playVideo();
    } else if (a === 'skip') rEmit('skip');
    else if (a === 'lofi') rEmit('lofi');
    else if (a === 'rm') rEmit('remove', { qid: b.dataset.q });
    else if (a === 'paste') pasteFromClipboard();
    else if (a === 'up' || a === 'down') rEmit('move', { qid: b.dataset.q, d: a === 'up' ? -1 : 1 });
  });
  // Перетаскивание треков в очереди (хост): мышью и пальцем
  dock.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip) return;
    const row = grip.closest('.lq-i');
    const list = row.parentElement;
    const rows = [...list.querySelectorAll('.lq-i')];
    const from = rows.indexOf(row);
    const h = row.getBoundingClientRect().height + 4;
    const y0 = e.clientY;
    let to = from;
    e.preventDefault();
    row.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dy = ev.clientY - y0;
      row.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
      rows.forEach((r, k) => {
        if (r === row) return;
        let shift = 0;
        if (from < to && k > from && k <= to) shift = -h;
        if (from > to && k < from && k >= to) shift = h;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      rows.forEach((r) => (r.style.transform = ''));
      row.classList.remove('dragging');
      if (to !== from) rEmit('moveTo', { qid: row.dataset.q, to });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  // Ссылка YouTube или Spotify → сразу в очередь
  const isSpotify = (u) => /open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/[A-Za-z0-9]{22}|^spotify:track:/.test(String(u || '').trim());
  let addBusy = false;
  async function addUrl(u, strict) {
    u = String(u || '').trim();
    if (!u || addBusy) return false;
    if (!ytId(u) && !isSpotify(u)) {
      if (strict) toast('Не похоже на ссылку YouTube или Spotify');
      return false;
    }
    addBusy = true;
    const btn = dock.querySelector('.lp-btn');
    btn && btn.classList.add('sending');
    if (isSpotify(u)) toast('Ищем этот трек на YouTube…', 'info');
    const r = await rEmit('add', { url: u });
    addBusy = false;
    btn && btn.classList.remove('sending');
    if (!r.error) Sound.play('pop');
    return !r.error;
  }
  async function addFromInput(inp, strict) {
    if (await addUrl(inp.value, strict)) inp.value = '';
  }
  // Кнопка «Вставить из буфера»; если браузер не даёт читать буфер — показываем поле
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return toast('В буфере пусто — скопируйте ссылку на трек', 'info');
      await addUrl(text, true);
    } catch {
      const f = dock.querySelector('.lofi-add');
      f.hidden = false;
      f.querySelector('input').focus();
      toast('Браузер не дал прочитать буфер — вставьте ссылку в поле (Ctrl+V)', 'info');
    }
  }
  // Ctrl+V, пока открыт плеер и курсор не в поле ввода, — тоже добавляет трек
  document.addEventListener('paste', (e) => {
    if (dock.hidden || dock.classList.contains('mini')) return;
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (text && (ytId(text.trim()) || isSpotify(text))) addUrl(text, true);
  });
  dock.addEventListener('submit', (e) => {
    e.preventDefault();
    addFromInput(e.target.querySelector('input'), true);
  });
  let addT = 0;
  dock.addEventListener('input', (e) => {
    if (e.target.name === 'url') {
      clearTimeout(addT);
      addT = setTimeout(() => addFromInput(e.target, false), 200);
      return;
    }
    if (e.target.dataset.lofi !== 'vol') return;
    music.vol = Number(e.target.value);
    LS.set('pg_lofi_vol', String(music.vol));
    try {
      music.player && music.ready && music.player.setVolume(music.vol / 2);
    } catch {}
  });

  // ---------- маршрутизация ----------
  function codeFromUrl() {
    const m = location.pathname.match(/^\/r\/([A-Za-z]{4})/) || location.hash.match(/^#([A-Za-z]{4})/);
    return m ? m[1].toUpperCase() : null;
  }
  const roomLink = (code) => `${location.origin}/r/${code}`;
  const identity = () => ({ name: LS.get('pg_name', ''), real: LS.get('pg_real', '') });
  const quietEmit = (ev, data) => new Promise((res) => socket.emit(ev, data, (r) => res(r || {})));
  // Загружаем своё фото на сервер (он отдаёт короткую ссылку). Без фото — инициалы.
  async function photoUrl() {
    const data = myPhoto();
    if (!data) return null;
    const r = await quietEmit('uploadAvatar', { data });
    return r.url || null;
  }
  const enterPayload = async () => ({ ...identity(), avatar: await photoUrl() });

  async function joinRoom(code) {
    const id = identity();
    if (!id.name) return render(); // зашёл по ссылке впервые — сначала ник
    const r = await emit('joinRoom', { token, code, ...(await enterPayload()) });
    if (r.error) {
      history.replaceState(null, '', '/');
      render();
      loaded('boot');
    }
  }

  socket.on('connect', () => {
    connected = true;
    const code = S?.room.code || codeFromUrl();
    if (code && identity().name) joinRoom(code);
    else {
      if (code) joinRoom(code);
      else render();
      loaded('boot');
    }
  });
  socket.on('connect_error', () => {
    // сервер недоступен — убираем экран загрузки, покажем обычное состояние «нет связи»
    if (Loader.has('boot')) render(), loaded('boot');
  });
  socket.on('disconnect', () => {
    connected = false;
    render();
  });
  // ===== Объявления о подарках: затемнение + размытие, крупный текст, анимация; по очереди =====
  const annQ = [];
  let annBusy = false;
  socket.on('gift', (ev) => {
    if (!S) return;
    annQ.push(ev);
    playAnn();
    setTimeout(render, 30); // подарок на аватарке появится с анимацией
  });
  socket.on('coins', ({ add, by }) => {
    toast(by ? `+${add} монет от хоста` : `+${add} монет за время в игре`, 'coinup');
    Sound.play('coin');
  });
  const rnd = (a, b) => a + Math.random() * (b - a);
  // Частицы для каждого подарка — чем дороже, тем богаче
  function giftFx(id) {
    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
    const P = (cls, html, vars) => `<i class="p ${cls}" style="${Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';')}">${html}</i>`;
    switch (id) {
      case 'kiss':
        return many(12, () => P('heart', '❤️', { x: `${rnd(-45, 45)}vw`, y: `${rnd(-40, -10)}vh`, d: `${rnd(0, 300)}ms`, r: `${rnd(-40, 40)}deg`, s: rnd(0.6, 1.3).toFixed(2) }));
      case 'rose':
        return many(26, () => P('petal', '', { x: `${rnd(0, 100)}vw`, d: `${rnd(0, 500)}ms`, r: `${rnd(0, 360)}deg`, dx: `${rnd(-12, 12)}vw`, s: rnd(0.6, 1.4).toFixed(2) }));
      case 'beer':
        return many(18, () => P('bubble', '', { x: `${rnd(-14, 14)}vw`, d: `${rnd(0, 600)}ms`, s: rnd(0.4, 1.2).toFixed(2) }));
      case 'slap':
        return P('boom', '💥', { x: '0vw', d: '330ms', s: 1 });
      case 'whisky':
        return many(8, () => P('ice', '🧊', { x: `${rnd(-30, 30)}vw`, y: `${rnd(-30, 20)}vh`, d: `${rnd(0, 300)}ms`, r: `${rnd(-60, 60)}deg`, s: rnd(0.6, 1).toFixed(2) }));
      case 'tomato':
        return many(14, () => P('splash', '', { x: `${rnd(-30, 30)}vw`, y: `${rnd(-25, 25)}vh`, d: `${380 + rnd(0, 120)}ms`, s: rnd(0.5, 1.6).toFixed(2), r: `${rnd(0, 360)}deg` }));
      case 'poop':
        return many(16, () => P('goo', '', { x: `${rnd(2, 98)}vw`, y: `${rnd(0, 55)}vh`, d: `${rnd(0, 250)}ms`, s: rnd(0.6, 1.8).toFixed(2) }));
      case 'crown':
        return '<i class="rays"></i>' + many(34, () => P('gold', '', { x: `${rnd(-48, 48)}vw`, y: `${rnd(-45, 45)}vh`, d: `${rnd(200, 1100)}ms`, s: rnd(0.4, 1.3).toFixed(2) })) + many(10, () => P('spark', '✨', { x: `${rnd(-35, 35)}vw`, y: `${rnd(-35, 35)}vh`, d: `${rnd(300, 1300)}ms`, s: rnd(0.6, 1.2).toFixed(2) }));
      case 'ring':
        return many(16, () => P('heart late', '💖', { x: `${rnd(-45, 45)}vw`, y: `${rnd(-45, -5)}vh`, d: `${rnd(900, 1500)}ms`, r: `${rnd(-40, 40)}deg`, s: rnd(0.6, 1.4).toFixed(2) })) + many(40, (i) => P('conf', '', { x: `${rnd(-50, 50)}vw`, y: `${rnd(-50, 30)}vh`, d: `${rnd(900, 1400)}ms`, r: `${rnd(0, 720)}deg`, c: ['#f2c14b', '#ff6aa2', '#7ad1ff', '#9dff9b', '#fff'][i % 5] }));
    }
    return '';
  }
  function playAnn() {
    if (annBusy || !annQ.length) return;
    const ev = annQ.shift();
    const g = GIFTS[ev.gift];
    if (!g || now() - ev.at > 15000) return playAnn(); // старое объявление (вкладка спала) — не показываем
    annBusy = true;
    const a = ev.from ? `<b>${esc(player(ev.from)?.name || 'Кто-то')}</b>` : '';
    const b = `<b>${esc(player(ev.to)?.name || 'игрок')}</b>`;
    const ms = { crown: 2800, ring: 3000, poop: 1900, tomato: 1900, slap: 1800 }[ev.gift] || 1600;
    const calm = document.documentElement.classList.contains('v-calm');
    const el = document.createElement('div');
    el.className = `gift-ov g-${ev.gift} ${ev.to === S.me ? 'to-me' : ''}`;
    el.style.setProperty('--ms', ms + 'ms');
    el.setAttribute('role', 'status');
    el.innerHTML = `<div class="go-fx" aria-hidden="true">${calm ? '' : giftFx(ev.gift)}</div>
      <div class="go-card">
        ${ev.gift === 'ring' ? '<div class="go-box" aria-hidden="true"><i class="lid"></i><i class="base"></i><span class="go-e">💍</span></div>' : `<div class="go-e">${g.e}</div>`}
        <div class="go-t">${g.say(a, b)}</div>
        <div class="go-d">${g.dur}</div>
      </div>`;
    document.body.appendChild(el);
    Sound.play('gift_' + ev.gift);
    setTimeout(() => el.classList.add('out'), ms - 380);
    setTimeout(() => {
      el.remove();
      annBusy = false;
      playAnn();
    }, ms);
  }

  socket.on('kicked', () => {
    S = null;
    syncRadio();
    history.replaceState(null, '', '/');
    toast('Вы покинули комнату', 'info');
    render();
  });
  // Звуки и анимации по изменению состояния игры
  function detectEvents(prev, next) {
    if (!prev) return;
    const me = next.me;
    const a = prev.game, b = next.game;
    if (!b) return;
    if (!a || a.type !== b.type) return Sound.play('start');
    // Ожидание игроков: звук только когда игра действительно началась
    if (a.waiting || b.waiting) {
      if (a.waiting && !b.waiting) Sound.play('start');
      return;
    }
    if (b.type === 'codenames') {
      const fresh = [];
      b.cards.forEach((c, i) => c.revealed && !a.cards[i]?.revealed && fresh.push(i));
      if (fresh.length) {
        ui.flip = new Map(fresh.map((i) => [i, Date.now()]));
        setTimeout(() => (ui.flip = null), 800);
        const col = b.cards[fresh[0]].color;
        Sound.play(col === 'assassin' ? 'boom' : col === a.turn ? 'good' : 'bad');
      }
      if (b.winner && !a.winner) setTimeout(() => Sound.play(b.team[me] === b.winner ? 'win' : 'lose'), fresh.length ? 450 : 0);
      else if (a.step === 'setup' && b.step === 'clue') Sound.play('start');
      else if (a.winner && !b.winner) Sound.play('start');
      else if (b.turn !== a.turn && !b.winner) setTimeout(() => Sound.play(b.team[me] === b.turn ? 'myturn' : 'turn'), fresh.length ? 380 : 0);
      else if (a.step === 'clue' && b.step === 'guess' && b.team[me] === b.turn) Sound.play('myturn');
      if (b.pending && (!a.pending || a.pending.i !== b.pending.i)) Sound.play('vote');
      const strikes = (x) => (x.clues || []).reduce((n, c) => n + c.slots.filter((y) => y.done).length, 0);
      if (strikes(b) !== strikes(a)) Sound.play('strike');
    } else if (b.type === 'alias') {
      if (b.guessedNow > a.guessedNow) Sound.play('good');
      else if (b.skippedNow > a.skippedNow) Sound.play('bad');
      if (a.phase !== b.phase && b.phase === 'running') Sound.play('start');
      if (a.phase !== b.phase && b.phase === 'over') Sound.play('win');
    } else if (b.type === 'justone') {
      if (a.phase !== 'result' && b.phase === 'result') Sound.play(b.correct ? 'win' : 'bad');
      else if (a.phase !== b.phase) Sound.play('turn');
    } else if (b.type === 'spyfall') {
      if (a.phase !== 'over' && b.phase === 'over') Sound.play(b.result?.winner === 'spy' ? (b.spies?.includes(me) ? 'win' : 'lose') : b.result?.winner === 'town' ? (b.spies?.includes(me) ? 'lose' : 'win') : 'turn');
      if (a.phase !== 'guessing' && b.phase === 'guessing') Sound.play('myturn');
    } else if (b.type === 'poker') {
      if (a.trick.length !== b.trick.length && b.trick.length) Sound.play('tap');
      if (a.phase !== 'trick' && b.phase === 'trick') setTimeout(() => Sound.play(b.lastTrick?.winner === me ? 'good' : 'turn'), 300);
      if (a.turnPid !== b.turnPid && b.turnPid === me) Sound.play('myturn');
      if (b.phase === 'over' && a.phase !== 'over') Sound.play((b.winner || []).includes(me) ? 'win' : 'lose');
    } else if (b.type === 'dice') {
      if (a.rollId !== b.rollId && b.rollAt) Sound.play('dice');
      if (a.phase !== 'bust' && b.phase === 'bust') setTimeout(() => Sound.play('bad'), b.rollMs);
      if (a.turnPid !== b.turnPid && b.turnPid === me) Sound.play('myturn');
      if (b.phase === 'over' && a.phase !== 'over') Sound.play(b.winner === me ? 'win' : 'lose');
    } else if (b.type === 'majority') {
      if (a.phase === 'answer' && b.phase === 'review') Sound.play(b.preview?.[me] ? 'good' : 'turn');
      if (b.phase === 'over' && a.phase !== 'over') Sound.play((b.winners || []).includes(me) ? 'win' : 'lose');
    } else if (b.type === 'whoami') {
      if (a.turnPid !== b.turnPid) Sound.play(b.turnPid === me ? 'myturn' : 'turn');
      if (b.finishOrder.length > a.finishOrder.length) Sound.play('good');
    }
    // Начался ход у меня или у моей команды — короткий приятный сигнал (там, где выше его ещё нет)
    const myTurn = (g) => {
      if (!g) return false;
      if (g.type === 'alias') return !['teams', 'over'].includes(g.phase) && (g.explainer === me || g.turnTeam === g.myTeam);
      if (g.type === 'spyfall') return g.phase === 'play' && (g.asker === me || g.target === me);
      if (g.type === 'justone') return g.phase === 'guess' && g.isGuesser;
      if (g.type === 'quiz' || g.type === 'majority') return g.phase === 'answer' && g.round;
      return false;
    };
    const was = myTurn(a);
    const now2 = myTurn(b);
    if (now2 && (!was || (['quiz', 'majority'].includes(b.type) && a.round !== b.round) || (b.type === 'alias' && a.turnTeam !== b.turnTeam))) setTimeout(() => Sound.play('myturn'), 120);
    // Голос «да / нет / не знаю» в «Кто я?» — мягкий щелчок счётчика
    if (b.type === 'whoami' && a.q && b.q && a.q.id === b.q.id && a.q.yes + a.q.no + a.q.idk !== b.q.yes + b.q.no + b.q.idk) Sound.play('count');
    if (b.type === 'whoami' && b.q?.pend && !a.q?.pend) Sound.play('vote');
  }

  socket.on('state', (st) => {
    offset = st.serverNow - Date.now();
    const prevKey = S?.game ? S.game.type + (S.game.round || '') : null;
    detectEvents(S, st);
    // Мою подсказку выбрали лучшей — сердечки
    if (st.game?.type === 'justone' && st.game.heart === st.me && S?.game?.type === 'justone' && S.game.heart !== st.me && !st.game.isGuesser) heartRain();
    // Первая начавшаяся партия Коднеймс — предложить включить свечение хода
    if (!st.game?.waiting && ((st.game?.type === 'codenames' && st.game.step !== 'setup' && !st.game.winner && (!S?.game || S.game.type !== 'codenames' || S.game.step === 'setup')) || (st.game?.type === 'justone' && S?.game?.type !== 'justone')) && !LS.get('pg_glow_asked', '') && !ui.glowAsk) ui.glowAsk = ui.gaAnim = true;
    // Партия Коднеймс закончилась — показываем итоги
    if (S?.game?.type === 'codenames' && !S.game.winner && st.game?.type === 'codenames' && st.game.winner && st.game.summary) {
      ui.showSum = true;
      ui.sumAnim = true;
      confetti(st.game.winner);
    }
    if (st.game?.type !== 'codenames' || !st.game.winner) ui.showSum = false;
    // Открылась другая игра (у всех, не только у хоста) — короткий экран загрузки, пока доска дорисуется
    if (S && st.game && S.game?.type !== st.game.type) Loader.show('game');
    S = st;
    syncRadio();
    if (location.pathname !== `/r/${st.room.code}`) history.replaceState(null, '', `/r/${st.room.code}`);
    if (!S.game && !ui.selected) ui.selected = S.room.gameType;
    if (S.room.gameType !== ui.selected && !isHost()) ui.selected = S.room.gameType;
    const key = S.game ? S.game.type + (S.game.round || '') : null;
    if (prevKey !== key) ui.hideCard = false;
    const g = S.game;
    if (g?.type !== 'codenames' || g.step !== 'clue') ui.cnSlots = ui.cnEdit ? ui.cnSlots : null;
    if (ui.cnEdit && (!g || g.type !== 'codenames' || !g.clue || g.clue.by !== S.me || now() > g.clue.editUntil)) {
      ui.cnEdit = false;
      ui.cnSlots = null;
    }
    render();
    if (Loader.has('boot') || Loader.has('enter') || Loader.has('game')) loaded('boot', 'enter', 'game');
  });

  // Нельзя случайно закрыть вкладку посреди игры
  window.addEventListener('beforeunload', (e) => {
    if (S && S.game) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  fetch('/api/games')
    .then((r) => r.json())
    .then((g) => {
      GAMES = g;
      render();
    });
  const gameMeta = (id) => GAMES.find((g) => g.id === id) || { title: id, settings: [], rules: [] };
  const gIcon = (id, size = 18) => ic(GAME_ICON[id] || 'dice', size);

  // ---------- сохранение ввода при перерисовке ----------
  function snapshotInputs() {
    const snap = {};
    $app.querySelectorAll('[data-keep]').forEach((el) => (snap[el.dataset.keep] = el.value));
    const a = document.activeElement;
    const focus = a && a.dataset && a.dataset.keep ? { k: a.dataset.keep, s: a.selectionStart, e: a.selectionEnd } : null;
    return { snap, focus };
  }
  function restoreInputs({ snap, focus }) {
    $app.querySelectorAll('[data-keep]').forEach((el) => {
      if (snap[el.dataset.keep] !== undefined && el.type !== 'checkbox') el.value = snap[el.dataset.keep];
    });
    if (focus) {
      const el = $app.querySelector(`[data-keep="${focus.k}"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(focus.s, focus.e);
        } catch {}
      }
    }
  }

  // ---------- общий рендер ----------
  // ===== Экран загрузки =====
  // Пока он открыт, страница дорисовывается под размытием: шрифты, фото игроков, шейдер фона.
  // Человек видит уже готовый экран — наклоны и анимации работают с первой секунды.
  const Loader = (() => {
    const el = document.getElementById('boot');
    const why = new Set(el ? ['boot'] : []);
    let shownAt = performance.now();
    let wall = Date.now();
    let hideT = 0;
    const MIN = 450; // не мигаем: если показали — держим хотя бы полсекунды
    const show = (r) => {
      if (!el) return;
      why.add(r);
      clearTimeout(hideT);
      if (!el.classList.contains('show')) {
        shownAt = performance.now();
        wall = Date.now();
        el.classList.add('show');
      }
    };
    const done = (...rs) => {
      if (!el) return;
      rs.forEach((r) => why.delete(r));
      if (why.size || !el.classList.contains('show')) return;
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        if (why.size) return;
        el.classList.remove('show', 'first');
        // вступительные анимации, которые успели пройти под размытием, — играем заново, уже на виду
        let again = false;
        if (ui.homeAt && ui.homeAt >= wall) (ui.homeAt = Date.now()), (again = true);
        if (ui.lobbyAt && ui.lobbyAt >= wall) (ui.lobbyAt = Date.now()), (again = true);
        if (ui.screenAt && ui.screenAt >= wall) (ui.lastScreen = null), (again = true);
        if (again) render();
      }, Math.max(0, MIN - (performance.now() - shownAt)));
    };
    const has = (r) => why.has(r);
    return { show, done, has };
  })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Ждём, пока всё на экране готово: шрифты, картинки (аватары) и пара кадров отрисовки
  function settle() {
    const imgs = [...$app.querySelectorAll('img')].filter((i) => !i.complete);
    const ready = Promise.all([document.fonts ? document.fonts.ready : null, ...imgs.map((i) => new Promise((r) => ((i.onload = i.onerror = r), setTimeout(r, 2500))))]);
    return Promise.race([ready.then(frames), sleep(4000)]);
  }
  const loaded = (...rs) => settle().then(() => Loader.done(...rs));
  setTimeout(() => Loader.done('boot', 'enter', 'game'), 8000); // 'login' держится свои 10 секунд // страховка: сервер молчит — не держим экран вечно

  // Анимированные счётчики очков: число «докручивается» до нового значения и подпрыгивает.
  // Значение берём из текста, прошлое — из памяти по ключу data-cnt, так что перерисовки не мешают.
  const cntMem = new Map();
  const cntRun = new Map(); // ключ → {from, to, at}
  function animateCounts() {
    const els = $app.querySelectorAll('[data-cnt]');
    const t = performance.now();
    const seen = new Set();
    els.forEach((el) => {
      const k = el.dataset.cnt;
      seen.add(k);
      const to = Number(el.textContent);
      if (!Number.isFinite(to)) return;
      const prev = cntMem.get(k);
      cntMem.set(k, to);
      let run = cntRun.get(k);
      if (prev != null && prev !== to && !document.documentElement.classList.contains('v-calm')) {
        const cur = run && run.to !== to ? Math.round(run.from + (run.to - run.from) * Math.min(1, (t - run.at) / run.d)) : prev;
        run = { from: cur, to, at: t, d: Math.min(900, 280 + Math.abs(to - cur) * 90), up: to > cur };
        cntRun.set(k, run);
      }
      if (run && t - run.at < run.d) {
        el.classList.add('cnt-run', run.up ? 'cnt-up' : 'cnt-down');
        el.style.setProperty('--ce', -(t - run.at) + 'ms');
        el.textContent = String(run.from);
      } else if (run) cntRun.delete(k);
    });
    for (const k of cntMem.keys()) if (!seen.has(k)) cntMem.delete(k);
    if (cntRun.size && !cntTick) cntTick = requestAnimationFrame(stepCounts);
  }
  let cntTick = 0;
  function stepCounts() {
    cntTick = 0;
    const t = performance.now();
    for (const [k, r] of cntRun) {
      const el = $app.querySelector(`[data-cnt="${CSS.escape(k)}"]`);
      const p = Math.min(1, (t - r.at) / r.d);
      const e = 1 - Math.pow(1 - p, 3);
      if (el) el.textContent = String(Math.round(r.from + (r.to - r.from) * e));
      if (p >= 1) {
        cntRun.delete(k);
        if (el) el.classList.remove('cnt-run');
      }
    }
    if (cntRun.size) cntTick = requestAnimationFrame(stepCounts);
  }

  function render() {
    const keep = snapshotInputs();
    const sk = screenKey();
    ui.enter = sk !== ui.lastScreen;
    if (ui.enter) ui.screenAt = Date.now();
    ui.lastScreen = sk;
    // Прокрутка колонок команд сохраняется между перерисовками
    const colScroll = {};
    $app.querySelectorAll('.cn-col').forEach((el) => (colScroll[el.className] = el.scrollTop));
    // Прокручиваемые панели (игроки в «Кто я» и «Шпионе», история) — сохраняем прокрутку между перерисовками
    const keepScroll = {};
    $app.querySelectorAll('[data-scroll]').forEach((el) => (keepScroll[el.dataset.scroll] = el.scrollTop));
    const hadForm = !!$app.querySelector('.cform.side');
    const rb = $app.querySelector('.rl-body');
    const rulesScroll = rb && rb.dataset.g === String(ui.showRules) ? rb.scrollTop : 0;
    $app.innerHTML = S ? renderRoom() : renderHome();
    ui.popAnim = false;
    ui.rulesAnim = false;
    ui.sumAnim = false;
    ui.gaAnim = false;
    ui.tabAnim = false;
    ui.ctlAnim = false;
    ui.leaveAnim = false;
    restoreInputs(keep);
    animateCounts();
    window.FX && FX.refresh();
    const pv0 = document.getElementById('cn-preview');
    if (pv0) pv0.innerHTML = cluePreview();
    const rb2 = $app.querySelector('.rl-body');
    if (rb2) {
      rb2.scrollTop = rulesScroll;
      if (ui.rulesTabScroll) $app.querySelector('.rl-tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
      ui.rulesTabScroll = false;
    }
    $app.querySelectorAll('.cn-col').forEach((el) => {
      if (colScroll[el.className] != null) el.scrollTop = colScroll[el.className];
    });
    $app.querySelectorAll('[data-scroll]').forEach((el) => {
      if (keepScroll[el.dataset.scroll] != null) el.scrollTop = keepScroll[el.dataset.scroll];
    });
    const form = $app.querySelector('.cform.side');
    if (form && !hadForm) {
      const col = form.closest('.cn-col');
      if (col) col.scrollTo({ top: col.scrollHeight, behavior: 'smooth' }); // форма появилась — показать её
    }
    syncWave();
    fitBoard();
    fitWords();
    if ($app.querySelector('.qz-reveal')) qzLoop();
    tick();
  }

  // Голографические волны — только на входе и в лобби (в игре фон спокойный)
  const syncWave = () => window.FX && FX.setWave(!S || !S.game, theme());
  // Слово не влезает в карточку даже с переносами — уменьшаем шрифт только этой карточки
  function fitWords() {
    $app.querySelectorAll('.cn-card .w').forEach((w) => {
      const card = w.parentElement;
      w.style.fontSize = '';
      const room = card.clientHeight - 6;
      let k = w.classList.contains('phrase') ? 0.8 : 1;
      while (w.scrollHeight > room && k > 0.56) {
        k -= 0.06;
        w.style.fontSize = k + 'em';
      }
    });
  }

  // Ключ «экрана»: когда он меняется — плавно проявляем новую сцену
  function screenKey() {
    if (!S) return 'home';
    const g = S.game;
    if (!g) return 'lobby:' + ui.mode + (tour() ? ':' + tour().phase : '');
    return [g.type, g.phase, g.step === 'setup' ? 'setup' : g.winner ? 'over' : '', g.round, g.guesser, g.explainer].join(':');
  }

  // Поле Коднеймс: максимально широкое, но целиком помещается по высоте экрана
  const STATUS_H = 140; // = min-height .cn-status + отступ
  function fitBoard() {
    const board = $app.querySelector('.cn-board');
    if (!board) return;
    const center = board.parentElement;
    if (window.innerWidth <= 1000) {
      center.style.setProperty('--board-w', 'none');
      return;
    }
    // Считаем от верха колонки + фиксированная высота блока подсказки — размер поля не зависит
    // от того, что сейчас в блоке подсказки (форма капитана, ожидание или сама подсказка)
    const top = center.getBoundingClientRect().top + window.scrollY + STATUS_H;
    const demo = document.getElementById('demo-bar');
    const reserve = 24 + (demo ? demo.offsetHeight : 0);
    const availH = window.innerHeight - top - reserve;
    const gap = 10;
    const w = Math.max(460, (availH - 4 * gap) * 1.55 + 4 * gap);
    center.style.setProperty('--board-w', Math.round(w) + 'px');
  }
  let fitT;
  window.addEventListener('resize', () => {
    clearTimeout(fitT);
    fitT = setTimeout(() => {
      fitBoard();
      fitWords();
    }, 80);
  });

  // ---------- вход ----------
  // «Коднеймс, Элиас, …, Викторина и Ответ большинства» — всегда по актуальному каталогу
  function gamesLine() {
    const t = (GAMES.length ? GAMES.map((g) => g.title) : ['Коднеймс', 'Элиас', 'Шпион', 'Кто я?', 'Намёк понял', 'Викторина', 'Ответ большинства']).map((x) => x.replace(/\?$/, ''));
    return esc(t.length > 1 ? t.slice(0, -1).join(', ') + ' и ' + t[t.length - 1] : t[0]);
  }
  function renderHome() {
    const code = codeFromUrl();
    const photo = myPhoto();
    const nick = LS.get('pg_name', '');
    const header = `<div class="home-top">${themeToggle()}</div>`;
    const hero = `<div class="home-hero">
        <div class="logo-mark">${ic('dice', 40)}</div>
        <h1>Экранки <span>а не настолки — для своих</span></h1>
        <p class="lead">${gamesLine()} — по одной или марафоном с турнирной таблицей.</p>
      </div>`;
    if (!ui.homeAt) ui.homeAt = Date.now(); // первый показ — каскадная анимация
    const hel = Date.now() - ui.homeAt;
    const intro = hel < 1800 ? 'intro' : '';
    return `${header}<main class="home ${intro}" style="--el:${hel}ms">
      ${hero}
      <form class="card home-card" data-form="enter" autocomplete="on">
        <span class="lbl">${code ? `Вход в комнату ${esc(code)}` : 'Кто ты?'}</span>
        ${photoBlock(photo, nick)}
        <label class="fld"><span>Никнейм <i class="req">*</i></span><input class="inp" name="name" data-keep="home-name" maxlength="24" placeholder="Как тебя звать в игре" value="${esc(nick)}" autocomplete="nickname" required /></label>
        <label class="fld"><span>Реальное имя</span><input class="inp" name="real" data-keep="home-real" maxlength="40" placeholder="пожалуйста, введите чтобы я не путался" value="${esc(LS.get('pg_real', ''))}" autocomplete="name" /><small class="muted">Видно остальным, только если навести на твой аватар</small></label>
        <div class="enter-row">
          ${
            code
              ? `<button class="btn primary big" type="submit" name="go" value="join">Войти в комнату ${esc(code)}</button><button class="btn ghost" type="submit" name="go" value="create">или создать новую</button>`
              : `<button class="btn primary big" type="submit" name="go" value="create">Создать комнату</button>
                 <div class="row code-row"><input class="inp code-inp" name="code" data-keep="home-code" maxlength="4" placeholder="КОД" autocomplete="off" /><button class="btn" type="submit" name="go" value="join">Войти по коду</button></div>`
          }
        </div>
        ${connected ? '' : '<p class="muted small">Подключаемся к серверу…</p>'}
      </form>
    </main>
    ${ui.crop ? renderCrop() : ''}
    ${ui.ask ? renderAsk() : ''}`;
  }
  // Круг с фото + кнопки «Загрузить / Убрать» (на входе и в «Моём профиле»)
  function photoBlock(photo, nick) {
    const face = photo ? `<img src="${photo}" alt="" draggable="false">` : nick ? `<b>${esc(initials(nick))}</b>` : ic('user', 34);
    return `<div class="ph-row">
      <button type="button" class="ph-circle ${photo ? 'has' : ''}" data-act="photo-pick" style="--h:${hue(nick || '?')}" aria-label="${photo ? 'Заменить фото' : 'Загрузить фото'}">${face}<span class="ph-cam">${ic('camera', 16)}</span></button>
      <div class="ph-t"><b>Аватар</b><span class="muted small">${photo ? 'Готово — так тебя увидят остальные' : 'Своё фото — по желанию. Без него будут инициалы'}</span>
        <div class="ph-btns"><button type="button" class="btn sm" data-act="photo-pick">${ic('upload', 15)} ${photo ? 'Заменить' : 'Загрузить фото'}</button>${photo ? `<button type="button" class="btn sm ghost" data-act="photo-del">Убрать</button>` : ''}</div>
      </div>
    </div>`;
  }

  // ---------- подтверждение действий — своим окном, а не браузерным confirm() ----------
  // ask({ title, text, ok, danger, icon, value }) → Promise<boolean>
  function ask(o) {
    if (ui.ask) ui.ask.resolve(false);
    return new Promise((resolve) => {
      ui.ask = { ...o, resolve, anim: true };
      ui.menu = null;
      render();
      if (ui.ask) ui.ask.anim = false;
      setTimeout(() => document.querySelector('.ask-modal [data-act="ask-yes"]')?.focus(), 30);
    });
  }
  function askDone(v) {
    const a = ui.ask;
    if (!a) return;
    ui.ask = null;
    render();
    a.resolve(v);
  }
  function renderAsk() {
    const a = ui.ask;
    return `<div class="modal-bg ${a.anim ? '' : 'still'}" data-act="ask-no"></div>
      <div class="modal card ask-modal ${a.anim ? '' : 'still'}" role="alertdialog" aria-modal="true" aria-label="${esc(a.title)}">
        <div class="lm-ic ${a.danger ? 'danger' : ''}">${ic(a.icon || 'question', 26)}</div>
        <h3>${esc(a.title)}</h3>
        ${a.text ? `<p class="muted">${esc(a.text)}</p>` : ''}
        ${a.value != null ? `<input class="inp ask-val" readonly value="${esc(a.value)}" onfocus="this.select()">` : ''}
        <div class="lm-btns">${a.noCancel ? '' : `<button class="btn ghost" data-act="ask-no">${esc(a.cancel || 'Отмена')}</button>`}<button class="btn ${a.danger ? 'danger' : 'primary'}" data-act="ask-yes">${esc(a.ok || 'Да')}</button></div>
      </div>`;
  }

  // ---------- кадрирование фото под круг ----------
  const CROP_V = 280; // размер окна кадрирования, px
  const cropDims = (c) => {
    const base = CROP_V / Math.min(c.w, c.h);
    return { dw: c.w * base * c.z, dh: c.h * base * c.z };
  };
  function cropClamp(c) {
    const { dw, dh } = cropDims(c);
    const mx = (dw - CROP_V) / 2;
    const my = (dh - CROP_V) / 2;
    c.x = Math.max(-mx, Math.min(mx, c.x));
    c.y = Math.max(-my, Math.min(my, c.y));
  }
  const cropStyle = (c) => {
    const { dw, dh } = cropDims(c);
    return `width:${dw}px;height:${dh}px;transform:translate(calc(-50% + ${c.x}px), calc(-50% + ${c.y}px))`;
  };
  function renderCrop() {
    const c = ui.crop;
    return `<div class="modal-bg ${c.anim ? '' : 'still'}" data-act="crop-cancel"></div>
      <div class="modal card crop-modal ${c.anim ? '' : 'still'}" role="dialog" aria-modal="true" aria-label="Кадрирование фото">
        <div class="modal-h"><b>${ic('crop', 18)} Подгони фото под круг</b><button class="icon-x" data-act="crop-cancel" aria-label="Закрыть">${ic('x', 18)}</button></div>
        <div class="crop-box" data-crop style="width:${CROP_V}px;height:${CROP_V}px"><img src="${c.src}" alt="" draggable="false" data-crop-img style="${cropStyle(c)}"><span class="crop-ring"></span></div>
        <div class="crop-zoom">${ic('minus', 16)}<input type="range" min="1" max="4" step="0.01" value="${c.z}" data-crop-zoom aria-label="Масштаб">${ic('plus', 16)}</div>
        <p class="muted small c">Двигай фото пальцем или мышкой, масштаб — ползунком${matchMedia('(pointer:fine)').matches ? ' или колесом' : ''}</p>
        <div class="row end"><button class="btn ghost" data-act="crop-cancel">Отмена</button><button class="btn primary" data-act="crop-save">${ic('check', 16)} Сохранить</button></div>
      </div>`;
  }
  function cropPaint() {
    const el = document.querySelector('[data-crop-img]');
    if (el && ui.crop) el.setAttribute('style', cropStyle(ui.crop));
  }
  // Выбор файла: уменьшаем большое фото сразу (телефонные 12 Мп не нужны), потом окно кадрирования
  const fileInp = document.createElement('input');
  fileInp.type = 'file';
  fileInp.accept = 'image/*';
  fileInp.hidden = true;
  document.body.appendChild(fileInp);
  fileInp.addEventListener('change', () => {
    const f = fileInp.files && fileInp.files[0];
    fileInp.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Это не картинка');
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k);
      cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      ui.crop = { src: cv.toDataURL('image/jpeg', 0.92), w: cv.width, h: cv.height, z: 1, x: 0, y: 0, anim: true };
      ui.menu = null;
      render();
      ui.crop.anim = false;
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('Не получилось открыть картинку');
    };
    img.src = url;
  });
  // Картинка персонажа в «Кто я?»: уменьшаем до ~320 px, сжимаем и загружаем на сервер
  const whoFile = document.createElement('input');
  whoFile.type = 'file';
  whoFile.accept = 'image/*';
  whoFile.hidden = true;
  document.body.appendChild(whoFile);
  whoFile.addEventListener('change', () => {
    const f = whoFile.files && whoFile.files[0];
    whoFile.value = '';
    if (f) whoImgFrom(f);
  });
  function whoImgFrom(f) {
    if (!/^image\//.test(f.type)) return toast('Это не картинка');
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = async () => {
      URL.revokeObjectURL(url);
      let data = '';
      for (const side of [320, 240, 180]) {
        const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * k));
        cv.height = Math.max(1, Math.round(img.naturalHeight * k));
        const c2 = cv.getContext('2d');
        c2.imageSmoothingQuality = 'high';
        c2.drawImage(img, 0, 0, cv.width, cv.height);
        data = cv.toDataURL('image/webp', 0.82);
        if (!data.startsWith('data:image/webp')) data = cv.toDataURL('image/jpeg', 0.85);
        if (data.length * 0.75 < 140 * 1024) break;
      }
      const mine = (ui.whoImg = { prev: data, url: null });
      render();
      const r = await quietEmit('uploadAvatar', { data });
      if (ui.whoImg !== mine) return;
      if (r.error || !r.url) {
        ui.whoImg = null;
        toast(r.error || 'Не получилось загрузить картинку');
      } else mine.url = r.url;
      render();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('Не получилось открыть картинку');
    };
    img.src = url;
  }
  // Вставка картинки из буфера, пока загадываем персонажа
  document.addEventListener('paste', (e) => {
    const g = S?.game;
    if (!g || g.type !== 'whoami' || g.phase !== 'write' || !g.writeFor || g.writtenForTarget) return;
    const it = [...(e.clipboardData?.items || [])].find((x) => x.kind === 'file' && /^image\//.test(x.type));
    if (!it) return;
    e.preventDefault();
    whoImgFrom(it.getAsFile());
  });

  // Готовый круг: квадрат 256×256, внутри — то, что видно в окне
  function cropExport() {
    const c = ui.crop;
    const OUT = 256;
    const f = OUT / CROP_V;
    const { dw, dh } = cropDims(c);
    const cv = document.createElement('canvas');
    cv.width = cv.height = OUT;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const img = document.querySelector('[data-crop-img]');
    ctx.drawImage(img, (CROP_V / 2 + c.x - dw / 2) * f, (CROP_V / 2 + c.y - dh / 2) * f, dw * f, dh * f);
    const webp = cv.toDataURL('image/webp', 0.86);
    return webp.startsWith('data:image/webp') ? webp : cv.toDataURL('image/jpeg', 0.88);
  }
  let cropDrag = null;
  document.addEventListener('pointerdown', (e) => {
    if (!ui.crop || !e.target.closest('[data-crop]')) return;
    e.preventDefault();
    cropDrag = { x: e.clientX, y: e.clientY, cx: ui.crop.x, cy: ui.crop.y };
  });
  document.addEventListener('pointermove', (e) => {
    if (!cropDrag || !ui.crop) return;
    ui.crop.x = cropDrag.cx + e.clientX - cropDrag.x;
    ui.crop.y = cropDrag.cy + e.clientY - cropDrag.y;
    cropClamp(ui.crop);
    cropPaint();
  });
  const cropUp = () => (cropDrag = null);
  document.addEventListener('pointerup', cropUp);
  document.addEventListener('pointercancel', cropUp);
  document.addEventListener('input', (e) => {
    if (!ui.crop || !e.target.matches('[data-crop-zoom]')) return;
    const c = ui.crop;
    const z = Number(e.target.value);
    // зум к центру окна
    c.x *= z / c.z;
    c.y *= z / c.z;
    c.z = z;
    cropClamp(c);
    cropPaint();
  });
  document.addEventListener(
    'wheel',
    (e) => {
      if (!ui.crop || !e.target.closest('[data-crop]')) return;
      e.preventDefault();
      const c = ui.crop;
      const z = Math.max(1, Math.min(4, c.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      c.x *= z / c.z;
      c.y *= z / c.z;
      c.z = z;
      cropClamp(c);
      cropPaint();
      const r = document.querySelector('[data-crop-zoom]');
      if (r) r.value = z;
    },
    { passive: false }
  );
  // Фото сохранено: у себя — сразу, в комнате — загружаем и меняем аватар у всех
  async function setPhoto(data) {
    if (data) LS.set('pg_photo', data);
    else LS.set('pg_photo', '');
    if (!S) return render();
    if (!data) return emit('setAvatar', { avatar: null });
    const r = await emit('uploadAvatar', { data });
    if (r.url) emit('setAvatar', { avatar: r.url });
  }

  // Реальное имя — всплывает при наведении на любой аватар (на телефоне — по касанию)
  const realTip = document.createElement('div');
  realTip.className = 'real-tip';
  realTip.setAttribute('role', 'tooltip');
  document.body.appendChild(realTip);
  let realFor = null;
  let realT = 0;
  function showReal(el) {
    if (realFor === el) return;
    realFor = el;
    realTip.innerHTML = `<small>${esc(el.dataset.nick || '')} — это</small><b>${esc(el.dataset.real)}</b>`;
    const r = el.getBoundingClientRect();
    realTip.classList.add('on');
    const tw = realTip.offsetWidth;
    const th = realTip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(innerWidth - tw - 8, left));
    let top = r.top - th - 8;
    realTip.classList.toggle('below', top < 6);
    if (top < 6) top = r.bottom + 8;
    realTip.style.left = left + 'px';
    realTip.style.top = top + 'px';
  }
  function hideReal() {
    realFor = null;
    realTip.classList.remove('on');
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[data-real]');
    if (el) showReal(el);
    else if (realFor) hideReal();
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const el = e.target.closest && e.target.closest('[data-real]');
    if (!el) return hideReal();
    showReal(el);
    clearTimeout(realT);
    realT = setTimeout(hideReal, 2200);
  });
  addEventListener('scroll', hideReal, true);

  // ---------- комната ----------
  function renderRoom() {
    const r = S.room;
    const g = S.game;
    const t = tour();
    const meta = gameMeta(g ? g.type : ui.selected);
    let stage;
    if (t && t.phase === 'final') stage = renderTourFinal();
    else if (g) stage = (t ? renderTourBetween() : '') + renderGame(g);
    else stage = renderLobby();
    const title = g ? `${gIcon(g.type)}<span>${esc(meta.title)}</span>` : t ? `${ic('trophy')}<span>Марафон</span>` : `<span class="muted">Лобби</span>`;
    return `
    <div class="room ${g ? 'in-game game-' + g.type : 'in-lobby'}">
      <header class="topbar">
        <div class="tb-row">
          <div class="brand">${ic('dice', 22)}<b>Экранки</b></div>
          <div class="gtitle">${title}</div>
          ${peopleMenu()}
          <div class="top-actions">
            <button class="btn sm ghost coin-chip" data-act="gift-open" title="Ваши монеты — открыть подарки">${coinIc()}<b data-cnt="coins-top">${S.coins || 0}</b></button>
            ${g || !t ? `<button class="btn sm ghost" data-act="rules" title="Правила">${ic('book')}<span class="hide-m">Правила</span></button>` : ''}
            ${sfxMenu()}
            ${themeToggle()}
            ${viewMenu()}
            <button class="btn sm code-btn" data-act="copy" title="Скопировать ссылку на комнату">${ic('link', 16)}<span>${esc(r.code)}</span></button>
            <button class="btn sm ghost exit-btn" data-act="leave" title="Выйти из комнаты">${ic('logout', 16)}<span class="hide-m">Выйти</span></button>
          </div>
        </div>
        ${g && g.waiting ? '' : g && g.type === 'codenames' ? renderClock(g) : g ? gameClock(g) : ''}
      </header>
      ${!connected ? '<div class="offline">Нет соединения, переподключаемся…</div>' : ''}
      <main class="stage ${ui.enter ? 'enter' : ''}">
        ${stage}
      </main>
      ${renderDock()}
      ${ui.showRules ? renderRules() : ''}
      ${renderTourModal()}
      ${
        ui.leaveAsk
          ? `<div class="modal-bg ${ui.leaveAnim ? '' : 'still'}" data-act="leave-no"></div>
        <div class="modal card leave-modal ${ui.leaveAnim ? '' : 'still'}" role="alertdialog" aria-modal="true" aria-label="Выйти из комнаты">
          <div class="lm-ic">${ic('logout', 26)}</div>
          <h3>Выйти из комнаты?</h3>
          <p class="muted">${g ? 'Вы выйдете из текущей катки — вернуться в неё уже не получится, ваши очки в ней пропадут.' : 'Вернуться можно по той же ссылке.'}${isHost() ? ' Права хоста перейдут другому игроку.' : ''}</p>
          <div class="lm-btns"><button class="btn ghost" data-act="leave-no">Остаться</button><button class="btn danger" data-act="leave-yes">${ic('logout', 16)} Выйти</button></div>
        </div>`
          : ''
      }
      ${ui.glowAsk && g && ['codenames', 'justone'].includes(g.type) ? `<div class="glow-ask card ${ui.gaAnim ? 'anim' : ''}" role="dialog" aria-label="Свечение хода">
          <span class="ga-ic">${ic('sparkles', 20)}</span>
          <div class="ga-t"><b>Подсветить, чей ход?</b><span class="muted small">Мягкое мерцание по краю экрана: в Коднеймс — цветом команды с её стороны, в «Намёк понял» — сверху. Подвиньте фейдер — потом можно поменять в меню «Вид».</span></div>
<div class="glow-ask-f">${glowFader()}</div>
          <button class="btn sm primary" data-act="glow-ok">Готово</button>
        </div>` : ''}
      ${ui.showSum && g && g.type === 'codenames' && g.winner ? cnSummaryModal(g) : ''}
      ${ui.meEdit ? renderMeModal() : ''}
      ${ui.crop ? renderCrop() : ''}
      ${ui.ask ? renderAsk() : ''}
    </div>`;
  }

  // Участники — одной кнопкой в шапке (аватарки + число), список в выпадающем окне
  function peopleMenu() {
    const r = S.room;
    const g = S.game;
    const cn = g && g.type === 'codenames' ? g : null;
    const open = ui.menu === 'people';
    const online = r.players.filter((p) => p.connected);
    const stack = online.slice(0, 4).map((p) => avaHtml(p, 24, 'round')).join('');
    const rows = r.players
      .map((p) => {
        const team = cn ? cn.team[p.id] : null;
        const cap = cn && (cn.captain.red === p.id || cn.captain.blue === p.id);
        const tag = cn ? (team ? (cap ? `капитан ${team === 'red' ? 'красных' : 'синих'}` : team === 'red' ? 'красные' : 'синие') : 'зритель') : '';
        const mine = p.id === S.me;
        const acts = [];
        if (mine) acts.push(`<button class="icon-x" data-act="me-open" title="Мой профиль: ник, реальное имя, фото">${ic('pencil', 16)}</button>`);
        if (isHost()) acts.push(`<button class="icon-x coin-btn ${ui.grantFor === p.id ? 'on' : ''}" data-act="grant-open" data-pid="${p.id}" title="Начислить монеты">${coinIc()}</button>`);
        if (isHost() && !mine) {
          acts.push(`<button class="icon-x" data-act="makeHost" data-pid="${p.id}" title="Сделать хостом">${ic('crown', 16)}</button>`);
          acts.push(`<button class="icon-x danger" data-act="kick" data-pid="${p.id}" title="Выгнать">${ic('x', 16)}</button>`);
        }
        return `<div class="pp-row ${p.connected ? '' : 'off'} ${mine ? 'me' : ''} ${team ? 't-' + team : ''}">
          ${avaHtml(p, 32, 'round')}
          <div class="pp-n"><span>${esc(p.name)}${mine ? ' <small class="muted">(вы)</small>' : ''}${p.id === r.hostId ? ` <span class="pm-host" title="Хост">${ic('crown', 13)}</span>` : ''}</span>
            <small>${p.connected ? tag || (p.id === r.hostId ? 'хост' : 'в комнате') : 'офлайн'}</small></div>
          <div class="pp-acts">${acts.join('')}</div>
        </div>
        ${isHost() && ui.grantFor === p.id ? `<div class="pp-grant"><span class="muted small">Начислить ${mine ? 'себе' : esc(p.name)}:</span>${[100, 300, 500, 1000].map((n) => `<button class="btn xs ghost" data-act="grant" data-pid="${p.id}" data-n="${n}">+${n}</button>`).join('')}</div>` : ''}`;
      })
      .join('');
    return `<div class="menu-wrap" data-pop>
      <button class="btn sm ghost people-btn ${open ? 'on' : ''}" data-act="menu" data-menu="people" title="Участники">
        <span class="pb-stack">${stack}</span><span class="pb-n">${ic('users', 15)}<b>${r.players.length}</b></span>
      </button>
      ${
        open
          ? `<div class="pop people-pop ${ui.popAnim ? 'anim' : ''}">
              <div class="vp-h">Участники · ${r.players.length}${online.length !== r.players.length ? ` <span class="muted">(в сети ${online.length})</span>` : ''}</div>
              <div class="pp-list">${rows}</div>

            </div>`
          : ''
      }
    </div>`;
  }

  // Нижний правый угол: кубок марафона, управление хоста, подарки (вместо прежнего чата)
  function renderDock() {
    const g = S.game;
    const hostTools = g && isHost();
    const ctlOpen = hostTools && ui.ctlOpen; // панель хоста открыта, пока её не закроют шестерёнкой
    const giftOpen = ui.menu === 'gift';
    return `<div class="chat-dock">
      <div class="fab-row">
        ${tour() && tour().phase !== 'final' ? `<button class="chat-fab trophy-fab ${ui.showTable ? 'on' : ''} up" data-act="tour-table" title="Таблица марафона">${ic('trophy', 22)}</button>` : ''}
        ${
          hostTools
            ? `<div class="ctl-wrap">${ctlOpen || ui.ctlClosing ? renderControls(g) : ''}
               <button class="chat-fab gear ${ctlOpen ? 'on' : ''}" data-act="ctl-toggle" title="${ctlOpen ? 'Скрыть управление игрой' : 'Управление игрой (хост)'}" aria-expanded="${!!ctlOpen}">${ic(ctlOpen ? 'x' : 'gear', 22)}${g.clock?.paused && !ctlOpen ? '<i class="badge warn-b">II</i>' : ''}</button></div>`
            : ''
        }
        <div class="gift-wrap" data-pop>
          ${giftOpen ? renderGiftMenu() : ''}
          <button class="chat-fab gift-fab ${giftOpen ? 'on' : ''}" data-act="gift-open" ${giftOpen ? "" : `title="Подарки и шалости"`} aria-expanded="${giftOpen}">${ic(giftOpen ? 'x' : 'heartf', 22)}</button>
        </div>
      </div>
    </div>`;
  }

  // Меню подарков: выбор подарка → кому → подтверждение
  function renderGiftMenu() {
    const coins = S.coins || 0;
    const st = ui.gs || { step: 'list' };
    const g = st.id && GIFTS[st.id];
    const head = `<div class="gm-head"><span class="gm-coins">${coinIc()}<b data-cnt="coins">${coins}</b></span><small>+300 за каждые 10 минут игры</small></div>`;
    let body = '';
    if (st.step === 'list' || !g) {
      body = `<div class="gm-title">Подарки и шалости</div>
        <div class="gm-grid">${GIFT_ORDER.map((id) => {
          const x = GIFTS[id];
          return `<button class="gm-item ${x.price > coins ? 'poor' : ''}" data-act="gift-pick" data-id="${id}"><span class="gm-e">${x.e}</span><span class="gm-n">${esc(x.short || x.name)}</span><span class="gm-p">${coinIc()}${x.price}</span></button>`;
        }).join('')}</div>`;
    } else if (st.step === 'to') {
      const others = S.room.players.filter((p) => p.id !== S.me);
      body = `<div class="gm-title"><button class="gm-back" data-act="gift-back" title="Назад">${ic('back', 16)}</button>${g.e} ${esc(g.name)} — кому?</div>
        <div class="gm-people">${others.length ? others.map((p) => {
          const crowned = st.id === 'crown' && giftsOf(p.id)?.crown;
          return `<button class="gm-person ${crowned ? 'off' : ''}" data-act="gift-to" data-pid="${p.id}" ${crowned ? 'disabled' : ''}>${pa(p.id, 34, 'round')}<b>${nm(p.id)}</b>${crowned ? '<small>уже с короной</small>' : p.connected === false ? '<small>не в сети</small>' : ''}</button>`;
        }).join('') : '<p class="muted small">В комнате пока никого, кроме вас</p>'}</div>`;
    } else {
      body = `<div class="gm-title"><button class="gm-back" data-act="gift-back" title="Назад">${ic('back', 16)}</button>Подтвердите</div>
        <div class="gm-ok">
          <span class="gm-ok-e">${g.e}</span>
          <div class="gm-ok-t"><b>${esc(g.name)}</b><span>для ${pa(st.to, 22, 'round')} <b>${nm(st.to)}</b></span>${g.anon ? '<small>анонимно — никто не узнает, что это вы</small>' : ''}</div>
          <span class="gm-ok-p">${coinIc()}${g.price}</span>
        </div>
        <div class="gm-btns"><button class="btn ghost" data-act="gift-back">Отмена</button><button class="btn primary" data-act="gift-send" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Отправляем…' : `Подарить за ${g.price}`}</button></div>`;
    }
    return `<div class="pop gift-pop ${ui.popAnim ? 'anim' : ''}">${head}${body}</div>`;
  }
  const coinIc = () => '<i class="coin" aria-hidden="true"></i>';

  function renderMeModal() {
    const me = player(S.me) || {};
    return `<div class="modal-bg ${ui.meAnim ? '' : 'still'}" data-act="me-close"></div>
      <form class="modal card me-modal ${ui.meAnim ? '' : 'still'}" data-form="me" role="dialog" aria-modal="true" aria-label="Мой профиль">
        <div class="modal-h"><b>${ic('user', 18)} Мой профиль</b><button type="button" class="icon-x" data-act="me-close" aria-label="Закрыть">${ic('x', 18)}</button></div>
        ${photoBlock(myPhoto(), me.name)}
        <label class="fld"><span>Никнейм <i class="req">*</i></span><input class="inp" name="name" data-keep="me-name" maxlength="24" value="${esc(me.name || '')}" required /></label>
        <label class="fld"><span>Реальное имя</span><input class="inp" name="real" data-keep="me-real" maxlength="40" placeholder="пожалуйста, введите чтобы я не путался" value="${esc(me.real || '')}" /><small class="muted">Видно остальным при наведении на твой аватар</small></label>
        <div class="row end"><button type="button" class="btn ghost" data-act="me-close">Отмена</button><button class="btn primary">Сохранить</button></div>
      </form>`;
  }

  // Правила — модалка поверх всего, вкладки по играм. Тексты — public/js/rules.js
  function renderRules() {
    const id = RULES[ui.showRules] ? ui.showRules : 'codenames';
    const R = RULES[id];
    const tabs = [...GAMES.map((x) => x.id), 'tour'].filter((k) => RULES[k]);
    const sec = (icon, title, body) => `<section class="rl-sec"><h4>${ic(icon, 16)} ${title}</h4>${body}</section>`;
    return `<div class="modal-bg rules-bg ${ui.rulesAnim ? 'anim' : ''}" data-act="rules"></div>
    <div class="modal rules-modal card ${ui.rulesAnim ? 'anim' : ''}" role="dialog" aria-modal="true" aria-label="Правила">
      <div class="rl-top">
        <div class="rl-tabs">${tabs.map((k) => `<button class="${k === id ? 'on' : ''}" data-act="rules-tab" data-g="${k}">${k === 'tour' ? ic('trophy', 16) : gIcon(k, 16)}<span>${esc(RULES[k].title)}</span></button>`).join('')}</div>
        <button class="icon-x" data-act="rules" title="Закрыть (Esc)">${ic('x', 20)}</button>
      </div>
      <div class="rl-body" data-g="${id}">
        <div class="rl-hero">
          <span class="rl-ic">${id === 'tour' ? ic('trophy', 30) : gIcon(id, 30)}</span>
          <div><h3>${esc(R.title)}</h3><p>${esc(R.goal)}</p>${R.meta ? `<div class="rl-meta">${R.meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : ''}</div>
        </div>
        ${R.roles ? sec('users', 'Кто есть кто', `<div class="rl-roles">${R.roles.map((r) => `<div class="rl-role"><b>${esc(r[0])}</b><span>${esc(r[1])}</span></div>`).join('')}</div>`) : ''}
        ${sec('list', 'Как проходит игра', `<ol class="rl-steps">${R.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`)}
        ${R.timers ? sec('clock', 'Время', `<div class="rl-pts">${R.timers.map((p) => `<div class="rl-pt t ${p[0].startsWith('−') ? 'neg' : ''}"><b>${esc(p[0])}</b><span>${esc(p[1])}</span></div>`).join('')}</div>`) : ''}
        ${R.points ? sec('star', 'Очки', `<div class="rl-pts">${R.points.map((p) => `<div class="rl-pt ${p[0].startsWith('−') ? 'neg' : p[0] === '0' ? 'zero' : ''}"><b>${esc(p[0])}</b><span>${esc(p[1])}</span></div>`).join('')}</div>`) : ''}
        ${sec('trophy', 'Кто побеждает', `<p class="rl-win">${esc(R.win)}</p>`)}
        ${R.tips ? sec('bulb', 'Полезно знать', `<ul class="rl-tips">${R.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`) : ''}
      </div>
      <div class="rl-foot"><button class="btn primary" data-act="rules">Понятно</button></div>
    </div>`;
  }

  // ---------- управление хоста (открывается шестерёнкой у чата) ----------
  function renderControls(g) {
    const t = tour();
    // Кнопки хоста — круглые, как остальные; подпись — всплывающая подсказка над кнопкой
    const btn = (actName, icon, label, cls = '') => `<button class="chat-fab ctl-fab ${cls}" data-act="${actName}" data-tip="${label}" aria-label="${label}">${ic(icon, 20)}</button>`;
    // «+время» — кнопка с цифрой вместо иконки
    const plusT = (actName, sec) => `<button class="chat-fab ctl-fab plus-t" data-act="${actName}" data-tip="Добавить ${sec} секунд" aria-label="Добавить ${sec} секунд"><b>+${sec}</b></button>`;
    const items = [];
    if (g.waiting) {
      items.push(btn('wait-begin', 'play', 'Начать игру'));
    } else if (g.type === 'codenames') {
      if (isPrep(g)) items.push(btn('cn-force', 'play', 'Начать без ожидания'));
      if (g.clock) items.push(btn('cn-pause', g.clock.paused ? 'play' : 'pause', g.clock.paused ? 'Продолжить таймер' : 'Пауза таймера', g.clock.paused ? 'hot' : ''));
      if (!g.winner) items.push(btn('cn-reset', 'reset', 'Перезапустить таймер'));
      if (g.clock && !g.winner) items.push(plusT('h-addtime', 30));
      if (g.step === 'guess' && !g.winner) items.push(btn('h-clearvotes', 'x', 'Снять все голоса агентов'));
      items.push(btn('cn-shuffle', 'shuffle', 'Перемешать команды'));
      if (!t) items.push(btn('cn-new', 'grid', 'Новая доска'));
      if (!g.winner) items.push(btn('cn-end-force', 'skip', 'Передать ход сразу'));
    } else if (g.type === 'alias') {
      if (g.phase === 'running') {
        items.push(btn('h-pauseturn', g.paused ? 'play' : 'pause', g.paused ? 'Продолжить ход' : 'Пауза хода', g.paused ? 'hot' : ''));
        items.push(plusT('h-addtime', 15));
        items.push(btn('h-newword', 'reset', 'Заменить слово (без очков)'));
      }
      if (g.phase === 'review') items.push(btn('al-confirm-force', 'check', 'Подтвердить очки за всех'));
      if (['ready', 'running', 'review'].includes(g.phase)) items.push(btn('al-skipturn', 'skip', 'Пропустить ход'));
      if (g.phase === 'teams') items.push(btn('al-shuffle', 'shuffle', 'Перемешать команды'));
      if (!t) items.push(btn('al-restart', 'reset', 'Начать заново'));
    } else if (g.type === 'spyfall') {
      if (g.phase === 'play') {
        items.push(btn('h-pauseround', g.paused ? 'play' : 'pause', g.paused ? 'Продолжить раунд' : 'Пауза таймера раунда', g.paused ? 'hot' : ''));
        items.push(plusT('h-addtime', 60));
      }
      if (g.phase !== 'over') items.push(btn('spy-reveal', 'eye', 'Открыть карты'));
      if (!t) items.push(btn('spy-next', 'reset', 'Новый раунд'));
    } else if (g.type === 'whoami') {
      if (g.phase === 'play') {
        items.push(plusT('h-addtime', 30));
        if (g.q) items.push(btn('h-clearvotes', 'x', 'Сбросить ответы на вопрос'));
        if (g.q) items.push(btn('h-skipq', 'reset', 'Не засчитывать вопрос'));
        items.push(btn('who-next', 'skip', 'Передать ход'));
      }
      if (g.phase === 'write') items.push(btn('who-force', 'play', 'Начать сейчас'));
    } else if (g.type === 'justone') {
      if (g.phase === 'clues') items.push(btn('jo-force', 'skip', 'Не ждать остальных'));
      if (g.phase === 'filter') items.push(btn('jo-force', 'play', 'Показать угадывающему сейчас'));
      if (g.endsAt) items.push(plusT('h-addtime', 30));
      if (['clues', 'filter'].includes(g.phase)) items.push(btn('h-newword', 'shuffle', 'Другое слово'));
      if (g.phase !== 'over') items.push(btn('h-skipround', 'skip', 'Пропустить раунд (без очков)'));
      if (!t) items.push(btn('jo-restart', 'reset', 'Начать заново'));
    } else if (g.type === 'quiz') {
      if (g.phase === 'answer') {
        items.push(plusT('h-addtime', 15));
        items.push(btn('h-newq', 'shuffle', 'Другой вопрос'));
        items.push(btn('qz-skip', 'skip', 'Показать ответ сейчас'));
      }
      if (g.phase === 'reveal') items.push(btn('qz-skip', 'play', 'Следующий вопрос'));
      if (!t) items.push(btn('qz-restart', 'reset', 'Начать заново'));
    } else if (g.type === 'majority') {
      if (g.endsAt) items.push(plusT('h-addtime', 15));
      if (g.phase === 'answer') {
        items.push(btn('h-newq', 'shuffle', 'Другой вопрос'));
        items.push(btn('mj-skip', 'skip', 'Открыть ответы сейчас'));
      }
      if (g.phase === 'review') items.push(btn('mj-skip', 'play', 'Следующий вопрос'));
      if (!t) items.push(btn('mj-restart', 'reset', 'Начать заново'));
    } else if (g.type === 'poker') {
      if (g.phase !== 'over') items.push(btn('pk-redeal', 'shuffle', 'Пересдать'));
      if (!t) items.push(btn('pk-restart', 'reset', 'Начать заново'));
    } else if (g.type === 'dice') {
      if (g.phase !== 'over') items.push(btn('dc-skip', 'skip', 'Пропустить ход'));
      if (!t) items.push(btn('dc-restart', 'reset', 'Начать заново'));
    }
    items.push('<span class="ctl-sep"></span>');
    items.push(btn('stop', 'home', 'В лобби (пауза)'));
    return `<div class="ctl-row ${ui.ctlAnim ? 'anim' : ''} ${ui.ctlClosing ? 'closing' : ''}" role="toolbar" aria-label="Управление игрой">${items.join('')}</div>`;
  }

  // ---------- лобби ----------
  function renderLobby() {
    const host = isHost();
    const sel = ui.selected || S.room.gameType;
    const meta = gameMeta(sel);
    const link = roomLink(S.room.code);
    const sp = S.room.suspended;
    const paused = sp
      ? `<div class="card resume-card">
          <div class="rc-ic">${gIcon(sp.type, 28)}</div>
          <div class="rc-txt"><b>${sp.tour ? 'Марафон' : `«${esc(gameMeta(sp.type).title)}»`} на паузе</b><span class="muted small">${host ? 'Игра сохранена — можно вернуться в любой момент. Новая игра её заменит.' : 'Ждём, пока хост вернётся к игре.'}</span></div>
          ${host ? `<button class="btn primary big-w" data-act="resume">${ic('play', 16)} Вернуться к игре</button>` : ''}
        </div>`
      : '';
    const invite = `<div class="invite card">
        <div><div class="lbl">Пригласите друзей по ссылке</div><div class="link">${esc(link)}</div></div>
        <button class="btn primary" data-act="copy">${ic('link', 16)} Скопировать</button>
      </div>`;
    // Первое открытие лобби — каскадное появление блоков
    // держим класс 1,6 с; задержки анимаций считаются от первого показа (--el), поэтому перерисовка не «перезапускает» их
    if (!ui.lobbyAt) ui.lobbyAt = Date.now();
    const lel = Date.now() - ui.lobbyAt;
    const intro = lel < 1600 ? 'intro' : '';
    const wrap = (main) => `<div class="lobby-wrap ${intro}" style="--el:${lel}ms">${renderRoster()}<div class="lobby">${main}</div></div>`;
    if (!host)
      return wrap(`${paused}${invite}<div class="card center big-pad"><div class="big-ic">${ic('dice', 44)}</div><h2 class="h2">Хост выбирает игру</h2>
        <p class="muted">${nm(S.room.hostId)} настраивает игру или марафон. Пока можно почитать правила.</p></div>
        <div class="games-grid">${GAMES.map((x) => gameCard(x, false, sel)).join('')}</div>`);
    // Переключатель с «едущей» плашкой: при смене плашка и блоки под ним анимируются
    const ma = ui.modeAnim;
    ui.modeAnim = null;
    const tabs = `<div class="tabs seg2 ${ma ? 'anim-' + ma : ''}" data-mode="${ui.mode}"><i class="tab-ind" aria-hidden="true"></i><button class="${ui.mode === 'single' ? 'on' : ''}" data-act="mode" data-m="single">${ic('grid', 16)} Одна игра</button><button class="${ui.mode === 'tour' ? 'on' : ''}" data-act="mode" data-m="tour">${ic('trophy', 16)} Марафон</button></div>`;
    const pane = (html) => `<div class="mode-pane ${ma ? (ma === 'tour' ? 'in-right' : 'in-left') : ''}">${html}</div>`;
    if (ui.mode === 'tour') return wrap(`${paused}${invite}${tabs}${pane(renderTourBuilder())}`);
    return wrap(`${paused}${invite}${tabs}${pane(`
      <div class="games-grid">${GAMES.map((x) => gameCard(x, true, sel)).join('')}</div>
      <div class="card settings">
        <div class="settings-h"><b>${gIcon(meta.id)} ${esc(meta.title)}</b> <button class="link-btn" data-act="rules">как играть и как считаются очки?</button></div>
        <form data-form="start" class="set-form">
          ${(meta.settings || []).map((x) => renderSetting(x)).join('')}
          <button class="btn primary big" type="submit">${ic('play', 16)} Начать игру</button>
        </form>
      </div>`)}`);
  }

  // Колонка «В комнате»: большие карточки игроков, новые «влетают» — чтобы каждый чувствовал, что его ждали
  const rosterKnown = new Map(); // id → когда впервые увидели (для анимации «влетания»)
  let rosterInit = false;
  function renderRoster() {
    const r = S.room;
    const ps = r.players.slice().sort((a, b) => (b.id === r.hostId) - (a.id === r.hostId) || (b.connected - a.connected));
    const online = ps.filter((p) => p.connected).length;
    const t = Date.now();
    ps.forEach((p) => !rosterKnown.has(p.id) && rosterKnown.set(p.id, rosterInit ? t : 0));
    rosterInit = true;
    const fe = (p) => t - rosterKnown.get(p.id);
    const fresh = new Set(ps.filter((p) => rosterKnown.get(p.id) && fe(p) < 1700).map((p) => p.id));
    const mood = online >= 4 ? 'Компания собралась — можно начинать!' : online >= 2 ? 'Уже веселее. Зовите остальных!' : 'Пока вы один — позовите друзей';
    return `<aside class="roster card">
      <div class="ro-h"><div><b>В комнате</b><span class="ro-n">${online}</span></div><span class="muted small">${mood}</span></div>
      <div class="ro-list">${ps
        .map(
          (p, i) => `<div class="ro-p ${p.connected ? '' : 'off'} ${p.id === S.me ? 'me' : ''} ${fresh.has(p.id) ? 'fresh' : ''}" style="--i:${i}${fresh.has(p.id) ? `;--fe:${fe(p)}ms` : ''}">
            <span class="ro-ava">${avaHtml(p, 52, 'round')}${p.connected ? '<i class="ro-dot"></i>' : ''}</span>
            <span class="ro-t"><b>${esc(p.name)}${p.id === S.me ? ' <small class="muted">(вы)</small>' : ''}</b><small>${p.id === r.hostId ? `${ic('crown', 12)} хост` : p.connected ? (p.real ? esc(p.real) : 'в игре') : 'не в сети'}</small></span>
            ${p.id === r.hostId ? `<span class="ro-crown">${ic('crown', 16)}</span>` : ''}
          </div>`
        )
        .join('')}
        <button class="ro-p ro-add" data-act="copy" title="Скопировать ссылку-приглашение"><span class="ro-ava"><span class="ro-plus">${ic('plus', 22)}</span></span><span class="ro-t"><b>Позвать друга</b><small>скопировать ссылку</small></span></button>
      </div>
    </aside>`;
  }

  const gameCard = (g, clickable, sel) => `<button class="gcard ${g.id === sel && clickable ? 'active' : ''}" ${clickable ? `data-act="pick" data-id="${g.id}"` : 'disabled'}>
      <span class="gemoji">${gIcon(g.id, 28)}</span>
      <span class="gname">${esc(g.title)}</span>
      <span class="gshort">${esc(g.short)}</span>
      <span class="gfoot"><span class="gplayers">${ic('users', 14)} ${esc(g.players)}</span>${g.content ? `<span class="gplayers gcontent">${ic('book', 14)} ${esc(g.content)}</span>` : ''}</span>
    </button>`;

  function renderSetting(s, prefix = '') {
    const key = prefix + s.key;
    const v = ui.settings[key] ?? s.default;
    if (s.type === 'select') {
      // Свой дропдаун вместо системного <select>
      const opts = s.options.map((o) => (typeof o === 'object' ? { v: o.v, t: o.t } : { v: o, t: String(o) }));
      const cur = opts.find((o) => String(o.v) === String(v)) || opts[0];
      const open = ui.menu === 'dd:' + key;
      return `<div class="set"><span>${esc(s.label)}</span><div class="dd ${open ? 'open' : ''}" data-pop>
        <input type="hidden" name="${key}" value="${esc(cur.v)}" />
        <button type="button" class="dd-btn" data-act="dd-open" data-key="${key}" aria-haspopup="listbox" aria-expanded="${open}"><span>${esc(cur.t)}</span>${ic('chevron', 18, 'dd-car')}</button>
        ${open ? `<div class="pop dd-list ${ui.popAnim ? 'anim' : ''}" role="listbox">${opts.map((o) => `<button type="button" class="pop-i ${String(o.v) === String(cur.v) ? 'on' : ''}" data-act="dd-pick" data-key="${key}" data-v="${esc(o.v)}" role="option"><span>${esc(o.t)}</span>${String(o.v) === String(cur.v) ? ic('check', 16, 'tick') : ''}</button>`).join('')}</div>` : ''}
      </div></div>`;
    }
    if (s.type === 'checkbox') return `<label class="set check"><input type="checkbox" name="${key}" ${v ? 'checked' : ''}/><span>${esc(s.label)}</span></label>`;
    if (s.type === 'textarea')
      return `<label class="set wide"><span>${esc(s.label)}</span><textarea class="inp" name="${key}" data-keep="set-${key}" rows="2" placeholder="слово, ещё слово, …"></textarea></label>`;
    return '';
  }

  // ---------- марафон ----------
  // Примерная длительность одной катки (минуты) — с учётом выбранных настроек
  const setv = (id, key) => {
    const m = gameMeta(id);
    const def = (m.settings || []).find((x) => x.key === key)?.default;
    return Number(ui.settings[id + '__' + key] ?? def) || 0;
  };
  const EST = {
    codenames: () => 15,
    alias: (id) => 20 * (setv(id, 'target') || 40) / 40 * (setv(id, 'teams') || 2) / 2,
    spyfall: (id) => (setv(id, 'minutes') || 8) + 2,
    whoami: () => 15,
    justone: (id) => setv(id, 'target') || 15,
    quiz: (id) => ((setv(id, 'rounds') || 15) * ((setv(id, 'seconds') || 30) + 12)) / 60,
    majority: (id) => ((setv(id, 'rounds') || 10) * ((setv(id, 'seconds') || 45) + 20)) / 60,
    dice: () => 25,
    poker: (id) => ({ mini: 30, short: 50, full: 120 })[ui.settings[id + '__length'] || 'short'] || 50,
  };
  const estMin = (id) => (EST[id] ? EST[id](id) : 15);
  function fmtDur(min) {
    const m = min >= 30 ? Math.round(min / 5) * 5 : Math.max(1, Math.round(min));
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} ч ${r} мин` : `${h} ч`;
  }
  // Готовые марафоны: состав можно поменять после выбора
  const PRESETS = [
    { id: 'warm', title: 'Разминка', sub: '≈ 20 минут', plan: [['majority', 1], ['spyfall', 1]] },
    { id: 'hour', title: 'На час', sub: '≈ 1 час', plan: [['codenames', 2], ['quiz', 1], ['majority', 1], ['spyfall', 1]] },
    { id: 'evening', title: 'Весь вечер', sub: '≈ 2–2,5 часа', plan: [['codenames', 3], ['alias', 1], ['spyfall', 2], ['whoami', 1], ['justone', 1], ['quiz', 1], ['majority', 1]] },
  ];
  const presetOn = (pr) => {
    const on = ui.mOrder.filter((id) => ui.mOn[id]);
    return on.length === pr.plan.length && pr.plan.every(([id, n], k) => on[k] === id && (ui.mRounds[id] || 1) === n);
  };
  function applyPreset(pr) {
    ui.mOn = {};
    for (const [id, n] of pr.plan) {
      ui.mOn[id] = true;
      ui.mRounds[id] = n;
    }
    const ids = pr.plan.map(([id]) => id);
    ui.mOrder = [...ids, ...ui.mOrder.filter((id) => !ids.includes(id))];
  }
  function renderTourBuilder() {
    // все игры каталога — в конструкторе (новые добавляются в конец)
    const known = GAMES.map((x) => x.id);
    if (known.length) ui.mOrder = [...ui.mOrder.filter((id) => known.includes(id)), ...known.filter((id) => !ui.mOrder.includes(id))];
    let total = 0;
    let mins = 0;
    const presets = `<div class="m-presets">${PRESETS.map((pr) => {
      const t = pr.plan.reduce((a, [id, n]) => a + estMin(id) * n, 0);
      const n = pr.plan.reduce((a, [, k]) => a + k, 0);
      return `<button type="button" class="m-pre ${presetOn(pr) ? 'on' : ''}" data-act="m-preset" data-id="${pr.id}"><b>${esc(pr.title)}</b><span>${fmtDur(t)} · ${n} ${plural(n, 'катка', 'катки', 'каток')}</span></button>`;
    }).join('')}</div>`;
    const rows = ui.mOrder
      .map((id, k) => {
        const m = gameMeta(id);
        const on = !!ui.mOn[id];
        const rounds = ui.mRounds[id] || 1;
        if (on) {
          total += rounds;
          mins += estMin(id) * rounds;
        }
        return `<div class="mrow ${on ? 'on' : ''}">
          <div class="mhead">
            <label class="mcheck"><input type="checkbox" data-mon="${id}" ${on ? 'checked' : ''}/><span class="mname">${gIcon(id)} ${esc(m.title)}</span></label>
            <div class="mctl">
              ${on ? `<span class="m-est muted small" title="Примерно на ${rounds} ${plural(rounds, 'катку', 'катки', 'каток')}">≈ ${fmtDur(estMin(id) * rounds)}</span><span class="muted small hide-m">каток</span><div class="stepper"><button type="button" data-act="m-rounds" data-id="${id}" data-d="-1">−</button><b>${rounds}</b><button type="button" data-act="m-rounds" data-id="${id}" data-d="1">+</button></div>` : ''}
              <button type="button" class="icon-x mv" data-act="m-move" data-id="${id}" data-d="-1" ${k === 0 ? 'disabled' : ''} title="Выше">${ic('up', 16)}</button>
              <button type="button" class="icon-x mv" data-act="m-move" data-id="${id}" data-d="1" ${k === ui.mOrder.length - 1 ? 'disabled' : ''} title="Ниже">${ic('down', 16)}</button>
            </div>
          </div>
          ${on && (m.settings || []).length ? `<details class="mset" data-mopen="${id}" ${ui.mOpen[id] ? 'open' : ''}><summary>Настройки</summary><div class="set-form">${m.settings.map((x) => renderSetting(x, id + '__')).join('')}</div></details>` : ''}
        </div>`;
      })
      .join('');
    return `<form data-form="tour" class="card tour-form">
        <div class="settings-h"><b>${ic('trophy')} Марафон</b><span class="muted small">Возьмите готовый или соберите свой: игры, порядок, число каток</span></div>
        ${presets}
        ${rows}
        <div class="mfoot"><span>Всего: <b>${total}</b> ${plural(total, 'катка', 'катки', 'каток')}${total ? ` · <b class="m-total">≈ ${fmtDur(mins)}</b>` : ''}</span><button class="btn primary" type="submit" ${total ? '' : 'disabled'}>${ic('trophy', 16)} Начать марафон</button></div>
        <p class="small muted mnote">За каждую катку: 1-е место — 3 очка, 2-е — 2, 3-е — 1. Турнирная таблица откроется после последней катки.</p>
      </form>`;
  }

  function tourRows() {
    const t = tour();
    const ids = new Set([...S.room.players.map((p) => p.id), ...Object.keys(t.totals)]);
    const types = [...new Set(t.queue.map((q) => q.type))];
    const rows = [...ids]
      .map((id) => {
        const per = {};
        for (const l of t.log) per[l.type] = (per[l.type] || 0) + (l.pts[id] || 0);
        return { id, total: t.totals[id] || 0, per };
      })
      .sort((a, b) => b.total - a.total);
    return { rows, types };
  }

  function tourTable() {
    const { rows, types } = tourRows();
    let place = 0;
    let last = null;
    return `<div class="ttable-wrap"><table class="ttable"><thead><tr><th>#</th><th>Игрок</th>${types.map((ty) => `<th title="${esc(gameMeta(ty).title)}">${gIcon(ty, 16)}</th>`).join('')}<th>Итого</th></tr></thead><tbody>
      ${rows
        .map((r, i) => {
          if (r.total !== last) place = i + 1;
          last = r.total;
          return `<tr class="${r.id === S.me ? 'me' : ''}"><td>${place}</td><td>${player(r.id) ? who(r.id, 'sm') : '<span class="muted">ушёл</span>'}</td>${types.map((ty) => `<td>${r.per[ty] || 0}</td>`).join('')}<td><b data-cnt="tt-${r.id}">${r.total}</b></td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }

  // Таблица марафона — модальное окно поверх всего (кнопка-кубок рядом с настройками)
  function renderTourModal() {
    const t = tour();
    if (!t || !ui.showTable) return '';
    const item = t.queue[Math.min(t.idx, t.queue.length - 1)];
    const { rows } = tourRows();
    const podium = rows.slice(0, 3).filter((r) => r.total > 0);
    return `<div class="modal-bg ${ui.tabAnim ? '' : 'still'}" data-act="tour-table"></div>
      <div class="modal card tour-modal ${ui.tabAnim ? '' : 'still'}" role="dialog" aria-modal="true" aria-label="Таблица марафона">
        <div class="modal-h"><b>${ic('trophy', 18)} Марафон · катка ${Math.min(t.idx + 1, t.queue.length)} из ${t.queue.length}</b><button class="icon-x" data-act="tour-table">${ic('x', 18)}</button></div>
        <div class="tm-progress">${t.queue.map((q, i) => `<span class="tm-step ${i < t.idx || (i === t.idx && t.phase !== 'play') ? 'done' : i === t.idx ? 'now' : ''}" title="${esc(gameMeta(q.type).title)}">${gIcon(q.type, 14)}</span>`).join('')}</div>
        <p class="muted small">Сейчас: ${esc(gameMeta(item.type).title)}${item.of > 1 ? ` · ${item.n}/${item.of}` : ''}. Места в каждой катке: 1-е +3, 2-е +2, 3-е +1.</p>
        ${podium.length ? `<div class="tm-podium">${podium.map((r, i) => `<div class="tmp p${i + 1}"><span class="tmp-place">${i + 1}</span>${pa(r.id, 44, 'round')}<b>${nm(r.id)}</b><span class="tmp-pts">${r.total}</span></div>`).join('')}</div>` : ''}
        <div class="tm-table">${tourTable()}</div>
        <div class="row end"><button class="btn primary" data-act="tour-table">Закрыть</button></div>
      </div>`;
  }

  function renderTourStrip() {
    const t = tour();
    const item = t.queue[t.idx];
    const m = gameMeta(item.type);
    const { rows } = tourRows();
    const top = rows.slice(0, 3).filter((r) => r.total > 0);
    return `<div class="tstrip">
      <span class="tstep">${ic('trophy', 16)} Катка <b>${t.idx + 1}</b> из ${t.queue.length}</span>
      <span class="muted">${esc(m.title)}${item.of > 1 ? ` · ${item.n}/${item.of}` : ''}</span>
      <span class="ttop">${top.map((r) => `${pa(r.id, 'xs')}<b>${r.total}</b>`).join(' ')}</span>
      <button class="btn xs ghost" data-act="tour-table">${ui.showTable ? 'Скрыть таблицу' : 'Таблица'}</button>
    </div>${ui.showTable && t.phase === 'play' ? `<div class="card">${tourTable()}</div>` : ''}`;
  }

  function renderTourBetween() {
    const t = tour();
    if (t.phase !== 'between' && t.phase !== 'done') return '';
    const l = t.log[t.log.length - 1];
    const placed = Object.entries(l.pts)
      .filter(([, p]) => p > 0)
      .sort((a, b) => b[1] - a[1]);
    const next = t.queue[t.idx + 1];
    const PL = { 3: '1-е место', 2: '2-е место', 1: '3-е место' };
    return `<div class="card tour-between">
      <div class="kicker">Катка ${t.idx + 1} из ${t.queue.length} окончена</div>
      <div class="tb-pts">${placed.length ? placed.map(([id, p]) => `<div class="tb-row">${who(id, 'sm')}<span class="muted small">${PL[p]}</span><b>+${p}</b></div>`).join('') : '<p class="muted">В этой катке никто не набрал очков</p>'}</div>
      ${tourTable()}
      <div class="row c">${
        isHost()
          ? next
            ? `<button class="btn primary big-w" data-act="tour-next">Дальше: ${esc(gameMeta(next.type).title)} ${ic('play', 16)}</button>`
            : `<button class="btn primary big-w" data-act="tour-next">${ic('trophy', 16)} Итоги марафона</button>`
          : `<span class="muted">Ждём, пока ${nm(S.room.hostId)} запустит ${next ? 'следующую катку' : 'итоги'}</span>`
      }</div>
    </div>`;
  }

  // Номинации марафона — считаются из того, что происходило в играх
  const NOM_IC = { captain: 'crown', sniper: 'target', hints: 'heartf', detector: 'eye', spy: 'spy', sherlock: 'question', explainer: 'mic', quiz: 'hash' };
  function tourNoms() {
    const list = tour()?.nominations || [];
    if (!list.length) return '';
    return `<div class="noms"><div class="kicker">Номинации вечера</div><div class="nom-grid">${list
      .map(
        (n) => `<div class="nom"><span class="nom-ic">${ic(NOM_IC[n.key] || 'star', 20)}</span><b class="nom-t">${esc(n.title)}</b>
          <span class="nom-who">${n.pids.map((id) => `<span class="who-n">${pa(id, 'sm', 'round')}<span>${nm(id)}</span></span>`).join('')}</span>
          <span class="nom-u">${n.n} — ${esc(n.unit)}</span></div>`
      )
      .join('')}</div></div>`;
  }

  function renderTourFinal() {
    const { rows } = tourRows();
    const podium = rows.slice(0, 3);
    const order = [1, 0, 2].filter((i) => podium[i]);
    return `<div class="card center big-pad final">
      <div class="kicker">Марафон окончен</div>
      <h2 class="h2">${ic('trophy', 24)} ${podium[0] ? nm(podium[0].id) : ''} — чемпион!</h2>
      <div class="podium">${order
        .map((i) => `<div class="pod p${i + 1}">${pa(podium[i].id, 'lg')}<div class="pod-n">${nm(podium[i].id)}</div><div class="pod-bar"><span>${i + 1}</span><b>${podium[i].total} ${plural(podium[i].total, 'очко', 'очка', 'очков')}</b></div></div>`)
        .join('')}</div>
      ${tourNoms()}
      ${tourTable()}
      ${isHost() ? `<div class="row c"><button class="btn primary" data-act="tour-end">${ic('home', 16)} Вернуться в лобби</button></div>` : ''}
    </div>`;
  }

  // ---------- игры ----------
  function renderGame(g) {
    if (g.waiting) return rWaiting(g);
    const fn = { codenames: rCodenames, alias: rAlias, spyfall: rSpy, whoami: rWho, justone: rJust, quiz: rQuiz, majority: rMajority, dice: rDice, poker: rPoker }[g.type];
    return fn ? fn(g) : '<p>Неизвестная игра</p>';
  }
  const canRestart = () => isHost() && !tour();

  // «Ждём игроков»: игра уже открыта, все по ссылке попадают сюда. Хост жмёт «Начать» — тут и проверяется минимум.
  function rWaiting(g) {
    const meta = gameMeta(g.type);
    const ps = S.room.players;
    const link = roomLink(S.room.code);
    return `<section class="wait-screen">
      <div class="card wait-card">
        <div class="wait-ic">${gIcon(g.type, 34)}</div>
        <h2>${esc(meta.title)}</h2>
        <p class="wait-sub"><span class="wait-dots"><i></i><i></i><i></i></span>Ждём игроков</p>
        ${g.need ? `<p class="wait-need">${esc(g.need)} · сейчас ${ps.length}</p>` : ''}
        <div class="wait-people">${ps.map((p) => `<span class="wait-p ${p.connected ? '' : 'off'}">${avaHtml(p, 'md')}<span>${esc(p.name)}</span></span>`).join('')}</div>
        <div class="wait-link"><span class="muted">Ссылка для друзей</span><button class="btn sm" data-act="copy">${ic('link', 16)}<span>${esc(link.replace(/^https?:\/\//, ''))}</span></button></div>
        ${isHost()
          ? `<button class="btn primary big" data-act="wait-begin">${ic('play', 18)} Начать игру</button>`
          : `<p class="muted">Игру начнёт хост, когда все соберутся.</p>`}
      </div>
    </section>`;
  }

  const timerHtml = (endsAt, total) => {
    if (!endsAt) return '';
    const left = endsAt - now();
    const w = total ? Math.max(0, Math.min(100, (left / (total * 1000)) * 100)) : 100;
    return `<div class="timer ${left < 10000 ? 'low' : ''}" data-ends="${endsAt}" data-total="${total || 0}"><span class="t">${fmt(left)}</span><i style="width:${w}%"></i></div>`;
  };

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  let lastTickSec = null;
  const timeupSet = new Set();
  function tick() {
    const n = now();
    // тикаем последние 5 секунд таймера хода
    const clk = document.querySelector('[data-clock]') || document.querySelector('.stage [data-ends]');
    if (clk && clk.dataset.paused !== '1') {
      const sec = Math.ceil((Number(clk.dataset.ends) - n) / 1000);
      if (sec >= 1 && sec <= 5 && sec !== lastTickSec) Sound.play('tick');
      lastTickSec = sec;
    }
    // Время вышло — звук во всех играх (ставим на точный момент нуля, пока экран не сменился)
    document.querySelectorAll('[data-ends], [data-clock]').forEach((el) => {
      if (el.dataset.paused === '1') return;
      const ends = Number(el.dataset.ends);
      const left = ends - n;
      if (left > 0 && left <= 260 && !timeupSet.has(ends)) {
        timeupSet.add(ends);
        setTimeout(() => Sound.play('timeup'), left);
      }
    });
    document.querySelectorAll('[data-ends]').forEach((el) => {
      const left = Number(el.dataset.ends) - n;
      const t = el.querySelector('.t');
      if (t) t.textContent = fmt(left);
      const total = Number(el.dataset.total) * 1000;
      const bar = el.querySelector('i');
      if (bar && total) bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
      el.classList.toggle('low', left < 10000);
    });
    // отсчёт до следующего вопроса
    document.querySelectorAll('[data-nx]').forEach((el) => (el.textContent = Math.max(1, Math.ceil((Number(el.dataset.nx) - n) / 1000))));
    // Таймер хода Коднеймс под хедером
    document.querySelectorAll('[data-clock]').forEach((el) => {
      const paused = el.dataset.paused === '1';
      const left = paused ? Number(el.dataset.left) : Number(el.dataset.ends) - n;
      const total = Number(el.dataset.total);
      el.querySelector('.ck-fill').style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
      el.querySelector('.ck-t').textContent = fmt(left);
      el.classList.toggle('low', !paused && left < 10000);
    });
    // Кнопки, которые доступны ограниченное время (правка подсказки)
    document.querySelectorAll('[data-until]').forEach((el) => {
      const left = Number(el.dataset.until) - n;
      if (left <= 0) el.remove();
      else {
        const ring = el.querySelector('.ring-fg');
        if (ring) ring.style.strokeDashoffset = String(100 - (left / Number(el.dataset.span)) * 100);
        const s = el.querySelector('.secs');
        if (s) s.textContent = Math.ceil(left / 1000);
      }
    });
  }
  setInterval(tick, 200);

  const leaderboard = (pairs, mark) =>
    `<div class="leader">${pairs
      .sort((a, b) => b[1] - a[1])
      .map(([id, n], i) => `<div class="lrow ${id === mark ? 'turn' : ''} ${id === S.me ? 'me' : ''}"><span>${i === 0 && n > 0 ? `<span class="medal">${ic('medal', 14)}</span>` : ''}${who(id, 'sm')}</span><b data-cnt="lb-${id}">${n}</b></div>`)
      .join('')}</div>`;

  // Переносы по слогам (правила русского языка): вставляем мягкие переносы &shy;
  const HY = (() => {
    const a = '[абвгдеёжзийклмнопрстуфхцчшщъыьэюя]';
    const x = '[йъь]';
    const g = '[аеёиоуыэюя]';
    const c = '[бвгджзклмнпрстфхцчшщ]';
    return [
      new RegExp(`(${x})(${a}${a})`, 'gi'),
      new RegExp(`(${g}${c})(${c}${g})`, 'gi'),
      new RegExp(`(${c}${g})(${c}${g})`, 'gi'),
      new RegExp(`(${g}${c})(${c}${c}${g})`, 'gi'),
      new RegExp(`(${g}${c}${c})(${c}${c}${g})`, 'gi'),
      new RegExp(`(${c}${g})(${g}${a})`, 'gi'),
    ];
  })();
  const hyph = (word) =>
    word
      .split(' ')
      .map((w) => {
        if (w.length < 6) return w;
        let out = w;
        for (let k = 0; k < 2; k++) for (const r of HY) out = out.replace(r, '$1\u00AD$2');
        // не отрываем по одной букве с краёв
        return out.replace(/^(.)\u00AD/, '$1').replace(/\u00AD(.)$/, '$1');
      })
      .join(' ');
  const hyphCache = new Map();
  const hy = (w) => (hyphCache.has(w) ? hyphCache.get(w) : (hyphCache.set(w, esc(hyph(w))), hyphCache.get(w)));

  // ===== Коднеймс =====
  const slotId = () => Math.random().toString(36).slice(2, 8);
  const fmtV = (v) => String(Math.round(Number(v) * 100) / 100);
  // Сила: от −1 до 1, кроме 0, до сотых. Минус — «точно не это слово»
  const STRENGTH_RE = /^[-−]?(0?[.,]\d{1,2}|1([.,]0{1,2})?)$/;
  const numV = (v) => parseFloat(String(v).trim().replace(',', '.').replace('−', '-'));
  const validStrength = (v) => STRENGTH_RE.test(String(v).trim()) && !!numV(v) && Math.abs(numV(v)) <= 1;
  // Группы связанных слотов: j — «связан с предыдущим»
  const groupsOf = (slots) => {
    const g = [];
    slots.forEach((x, k) => (x.j && k > 0 && g.length ? g[g.length - 1].push([x, k]) : g.push([[x, k]])));
    return g;
  };
  const TN = { red: 'Красные', blue: 'Синие' };
  const TNg = { red: 'красных', blue: 'синих' };

  // Чипы подсказки: активные — белые, зачёркнутые — погашены. Капитан своей команды кликает, чтобы зачеркнуть
  const clueChips = (c, canStrike) =>
    groupsOf(c.slots)
      .map((grp) => {
        const chips = grp
          .map(([x, k]) => {
            const neg = x.v < 0;
            const title = x.done ? 'зачёркнуто' : neg ? `точно НЕ это слово (${Math.round(-x.v * 100)}%)` : `подходит на ${Math.round(x.v * 100)}%`;
            return canStrike
              ? `<button type="button" class="num ${x.done ? 'done' : ''} ${neg ? 'neg' : ''} can" data-act="cn-strike" data-clue="${c.id}" data-k="${k}" title="${title} · нажмите, чтобы ${x.done ? 'вернуть' : 'зачеркнуть'}">${fmtV(x.v)}</button>`
              : `<span class="num ${x.done ? 'done' : ''} ${neg ? 'neg' : ''}" title="${title}">${fmtV(x.v)}</span>`;
          })
          .join('<i class="plus-j">+</i>');
        return grp.length > 1 ? `<span class="grp" title="Связанные слова: ищите их вместе">${ic('link', 11)}${chips}</span>` : chips;
      })
      .join('');
  function cluePreview() {
    const word = $app.querySelector('.clue-word')?.value.trim() || ui.keep?.['cn-clue'] || 'слово';
    const slots = (ui.cnSlots || []).map((x) => ({ v: validStrength(x.v) ? numV(x.v) : null, j: x.j, raw: x.v }));
    return `<span class="pv-word">${esc(word)}</span> ${groupsOf(slots)
      .map((grp) => {
        const chips = grp.map(([x]) => `<span class="num ${x.v == null ? 'bad' : x.v < 0 ? 'neg' : ''}">${esc(x.v == null ? String(x.raw || '?') : fmtV(x.v))}</span>`).join('<i class="plus-j">+</i>');
        return grp.length > 1 ? `<span class="grp">${ic('link', 11)}${chips}</span>` : chips;
      })
      .join(' ')}`;
  }
  const ring = (cls = '', off = null) =>
    `<svg class="ring ${cls}" viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15.9"/><circle class="ring-fg" cx="18" cy="18" r="15.9" pathLength="100"${off != null ? ` style="stroke-dashoffset:${Math.max(0, Math.min(100, off))}"` : ''}/></svg>`;

  const prepPool = (g) => Object.keys(g.team).filter((id) => player(id)?.connected);
  const isPrep = (g) => g.step === 'setup' || (g.winner && !tour());

  // Конфетти со стороны победившей команды (красные слева, синие справа)
  function confetti(team) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.getElementById('confetti')?.remove();
    const cv = document.createElement('canvas');
    cv.id = 'confetti';
    document.body.appendChild(cv);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = (cv.width = innerWidth * dpr);
    const H = (cv.height = innerHeight * dpr);
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    const c = cv.getContext('2d');
    const left = team === 'red';
    const base = left ? ['#ff6452', '#ff9a8c', '#ffd2cb'] : ['#4fb8ff', '#9ad6ff', '#d4eeff'];
    const cols = [...base, '#f2c14b', '#ffffff'];
    const P = [];
    const spawn = (n) => {
      for (let i = 0; i < n; i++) {
        P.push({
          x: (left ? -10 : W + 10) + (Math.random() - 0.5) * 40 * dpr,
          y: H * (0.25 + Math.random() * 0.5),
          vx: (left ? 1 : -1) * (6 + Math.random() * 10) * dpr,
          vy: (-8 - Math.random() * 9) * dpr,
          w: (6 + Math.random() * 6) * dpr,
          h: (3 + Math.random() * 4) * dpr,
          r: Math.random() * 6,
          vr: (Math.random() - 0.5) * 0.4,
          col: cols[(Math.random() * cols.length) | 0],
        });
      }
    };
    spawn(110);
    setTimeout(() => spawn(70), 350);
    setTimeout(() => spawn(50), 800);
    const t0 = performance.now();
    const step = (t) => {
      c.clearRect(0, 0, W, H);
      for (const p of P) {
        p.vy += 0.32 * dpr;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.r);
        c.fillStyle = p.col;
        c.globalAlpha = Math.max(0, 1 - (t - t0) / 4200);
        c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        c.restore();
      }
      if (t - t0 < 4200) requestAnimationFrame(step);
      else cv.remove();
    };
    requestAnimationFrame(step);
  }

  // Итоги партии Коднеймс — окно с карточками, открывается само после победы
  const mmss = (ms) => {
    const t = Math.round(ms / 1000);
    return t < 60 ? `${t} сек` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  function cnSummaryModal(g) {
    const x = g.summary;
    if (!x) return '';
    const card = (icon, title, body, cls = '') => `<div class="sum-c ${cls}"><span class="sum-ic">${ic(icon, 18)}</span><div><div class="sum-t">${title}</div><div class="sum-b">${body}</div></div></div>`;
    const cards = [];
    if (x.bestClue) cards.push(card('star', 'Лучшая подсказка', `<b>${esc(x.bestClue.text)}</b> — ${who(x.bestClue.by)} · открыли ${x.bestClue.hits} ${plural(x.bestClue.hits, 'слово', 'слова', 'слов')}`));
    if (x.bold) cards.push(card('sparkles', 'Самая смелая', `<b>${esc(x.bold.text)}</b> — ${who(x.bold.by)} замахнулся на ${x.bold.n} ${plural(x.bold.n, 'слово', 'слова', 'слов')}, вышло ${x.bold.hits}`));
    if (x.fast) cards.push(card('clock', 'Молния', `${TN[x.fast.team]} нашли <b>${esc(x.fast.word)}</b> за ${mmss(x.fast.ms)} после подсказки`));
    if (x.sniper) cards.push(card('target', 'Снайпер', `${who(x.sniper.pid)} — ${x.sniper.n} ${plural(x.sniper.n, 'верный голос', 'верных голоса', 'верных голосов')}`));
    if (x.lead) cards.push(card('flag', 'Заводила', `${who(x.lead.pid)} первым тыкал в правильную карточку ${x.lead.n} ${plural(x.lead.n, 'раз', 'раза', 'раз')}`));
    if (x.slowCap && x.slowCap.ms > 20000) cards.push(card('pause', 'Философ', `${who(x.slowCap.pid)} думал над подсказкой ${mmss(x.slowCap.ms)}`));
    if (x.fastCap) cards.push(card('skip', 'Скорострел', `${who(x.fastCap.pid)} — в среднем ${mmss(x.fastCap.ms)} на подсказку`));
    if (x.waverer && x.waverer.n >= 2) cards.push(card('reset', 'Сомневающийся', `${who(x.waverer.pid)} передумал ${x.waverer.n} ${plural(x.waverer.n, 'раз', 'раза', 'раз')}`));
    if (x.miss) cards.push(card('x', 'Мимо кассы', `${who(x.miss.pid)} — ${x.miss.n} ${plural(x.miss.n, 'голос', 'голоса', 'голосов')} за чужие карточки`, 'bad'));
    const gift = x.gifts && (x.gifts.red || x.gifts.blue) ? (x.gifts.red >= x.gifts.blue ? 'red' : 'blue') : null;
    if (gift) cards.push(card('heart', 'Щедрые', `${TN[gift]} открыли соперникам ${x.gifts[gift]} ${plural(x.gifts[gift], 'карточку', 'карточки', 'карточек')}`, 'bad'));
    if (x.assassin?.length) cards.push(card('alert', 'Нашли убийцу', x.assassin.map((id) => who(id)).join(', '), 'bad'));
    return `<div class="modal-bg ${ui.sumAnim ? '' : 'still'}" data-act="cn-sum"></div>
      <div class="modal card sum-modal ${ui.sumAnim ? '' : 'still'}" role="dialog" aria-modal="true">
        <div class="modal-h"><b>${ic('trophy', 18)} Итоги партии — победили ${TN[g.winner].toLowerCase()}${g.reason === 'assassin' ? ' (соперники открыли убийцу)' : ''}</b><button class="icon-x" data-act="cn-sum">${ic('x', 18)}</button></div>
        <div class="sum-meta"><span>${ic('clock', 14)} ${mmss(x.duration)}</span><span>${ic('skip', 14)} ${x.turns} ${plural(x.turns, 'ход', 'хода', 'ходов')}</span><span>${ic('chat', 14)} ${x.clues} ${plural(x.clues, 'подсказка', 'подсказки', 'подсказок')}</span>${x.neutral ? `<span>Нейтральных открыто: ${x.neutral.red + x.neutral.blue}</span>` : ''}</div>
        <div class="sum-grid">${cards.join('') || '<p class="muted">Слишком короткая партия для итогов</p>'}</div>
        <div class="row end"><button class="btn primary" data-act="cn-sum">Дальше</button></div>
      </div>`;
  }

  // Единая полоса таймера под шапкой — такая же, как в Коднеймс, для всех игр
  function gameClock(g) {
    let c = null;
    if (g.type === 'alias' && g.phase === 'running' && (g.endsAt || g.paused)) c = { ends: g.endsAt, left: g.pausedLeft, paused: g.paused, total: g.seconds * 1000, team: g.teams?.[g.turnTeam]?.name, phase: `объясняет ${nm(g.explainer)}`, tc: ALIAS_BG[g.turnTeam] };
    else if (g.type === 'spyfall' && g.phase === 'play' && (g.endsAt || g.paused)) c = { ends: g.endsAt, left: g.pausedLeft, paused: g.paused, total: g.roundMs || 480000, team: `Раунд ${g.round}`, phase: 'вопросы и подозрения' };
    else if (g.type === 'whoami' && g.phase === 'play' && g.qEnds) c = { ends: g.qEnds, total: 60000, team: nm(g.turnPid), phase: 'придумывает вопрос' };
    else if (g.type === 'justone' && g.endsAt) c = { ends: g.endsAt, total: g.phaseMs || 30000, team: `Раунд ${g.round}`, phase: { clues: 'пишем подсказки', filter: 'убираем совпадения', guess: `угадывает ${nm(g.guesser)}`, result: g.correct ? 'выбор лучшей подсказки' : 'засчитать ли ответ' }[g.phase] || '' };
    else if (g.type === 'quiz' && g.endsAt && g.phase !== 'over') c = { ends: g.endsAt, total: g.phaseMs || 30000, team: `Вопрос ${g.round}/${g.rounds}`, phase: g.phase === 'answer' ? 'ответы' : 'результат' };
    else if (g.type === 'majority' && g.endsAt && g.phase !== 'over') c = { ends: g.endsAt, total: g.phaseMs || 45000, team: `Вопрос ${g.round}/${g.rounds}`, phase: g.phase === 'answer' ? 'тайные ответы' : 'разбор совпадений' };
    if (!c) return '';
    const left = c.paused ? c.left : c.ends - now();
    const w = Math.max(0, Math.min(100, (left / c.total) * 100));
    return `<div class="clockbar t-any ${c.paused ? 'paused' : ''} ${!c.paused && left < 10000 ? 'low' : ''}" ${c.tc ? `style="--tc:${c.tc}"` : ''} data-clock data-ends="${c.ends || 0}" data-left="${left}" data-total="${c.total}" data-paused="${c.paused ? 1 : 0}">
      <div class="ck-fill" style="width:${w}%"></div>
      <div class="ck-txt"><span class="ck-team">${esc(c.team || '')}</span><span class="ck-phase">${esc(c.phase || '')}</span>${c.paused ? `<span class="ck-p">${ic('pause', 12)} пауза</span>` : ''}<span class="ck-t">${fmt(left)}</span></div>
    </div>`;
  }

  function renderClock(g) {
    const c = g.clock;
    if (!c) {
      const pool = prepPool(g);
      const n = pool.filter((id) => g.ready[id]).length;
      return `<div class="clockbar idle"><div class="ck-txt">${ic(g.winner ? 'trophy' : 'users', 14)}<span>${g.winner ? 'Партия окончена' : 'Подготовка к партии'}</span>${isPrep(g) ? `<span class="ck-phase">готовы ${n} из ${pool.length}</span>` : ''}</div></div>`;
    }
    // Капитан не уложился — тикает уже время команды
    const phase = g.step === 'clue' ? (c.over ? 'капитан тратит время команды' : 'капитан думает') : c.over ? 'команда отгадывает (время урезано)' : 'команда отгадывает';
    const left = c.paused ? c.left : c.endsAt - now();
    const w = Math.max(0, Math.min(100, (left / c.total) * 100));
    return `<div class="clockbar t-${g.turn} ${c.over && g.step === 'clue' ? 'over' : ''} ${c.paused ? 'paused' : ''} ${!c.paused && left < 10000 ? 'low' : ''}" data-clock data-ends="${c.endsAt}" data-left="${c.left}" data-total="${c.total}" data-paused="${c.paused ? 1 : 0}">
      <div class="ck-fill" style="width:${w}%"></div>
      <div class="ck-txt"><span class="ck-team">${TN[g.turn]}</span><span class="ck-phase">${phase}</span>${c.paused ? `<span class="ck-p">${ic('pause', 12)} пауза</span>` : ''}<span class="ck-t">${fmt(left)}</span></div>
    </div>`;
  }

  // Форма капитана: слово → карточки с силой → отправка. Высота фиксированная — поле не сдвигается.
  function clueForm(g, mode) {
    if (!ui.cnSlots) ui.cnSlots = [{ id: slotId(), v: '1' }];
    const n = ui.cnSlots.length;
    // Между карточками — «нить»: нажал, и две соседние силы связаны (1+1)
    const slots = ui.cnSlots
      .map((x, k) => {
        const thread = k > 0 ? `<button type="button" class="thread ${x.j ? 'on' : ''}" data-act="cn-link" data-id="${x.id}" title="${x.j ? 'Развязать' : 'Связать с предыдущей'}"><span class="th-line"></span><span class="th-knot">${ic('link', 13)}</span><span class="th-t">${x.j ? 'связаны' : 'связать'}</span></button>` : '';
        const ok = validStrength(x.v);
        const neg = ok && numV(x.v) < 0;
        return `${thread}<div class="slot ${ok ? '' : 'bad'} ${neg ? 'neg' : ''} ${x.j ? 'joined' : ''} ${ui.cnSlots[k + 1]?.j ? 'joined-next' : ''}">
          <span class="slot-n">${k + 1}</span>
          <input type="range" min="-1" max="1" step="0.01" value="${ok ? numV(x.v) : 1}" data-slot="${x.id}" data-kind="range" aria-label="Сила для карточки ${k + 1}"/>
          <input class="inp slot-v" inputmode="decimal" maxlength="5" value="${esc(x.v)}" data-slot="${x.id}" data-kind="num" data-keep="cn-s-${x.id}" aria-label="Сила для карточки ${k + 1}"/>
          ${n > 1 ? `<button type="button" class="icon-x slot-x" data-act="cn-sdel" data-id="${x.id}" title="Убрать карточку">${ic('x', 13)}</button>` : ''}
        </div>`;
      })
      .join('');
    const word = mode === 'edit' ? esc(g.clue.word) : '';
    return `<form class="cform side t-${g.turn}" data-form="clue" data-mode="${mode}">
      <div class="cf-head">${ic('crown', 15)} ${mode === 'edit' ? 'Исправить подсказку' : 'Ваша подсказка'}</div>
      <label class="cf-l"><b>1</b> Слово</label>
      <input class="inp clue-word" name="word" data-keep="cn-clue${mode === 'edit' ? '-e' : ''}" data-preview="1" value="${word}" placeholder="Одно слово" maxlength="30" autocomplete="off" required/>
      <label class="cf-l"><b>2</b> Карточки и сила</label>
      <div class="cf-hint">1 — точно про это слово, 0.5 — наполовину, −1 — точно НЕ это. Жёлтая нить связывает силы: 1+1</div>
      <div class="slots">${slots}</div>
      ${n < 9 ? `<button type="button" class="add-slot" data-act="cn-sadd">${ic('plus', 15)} Ещё карточка</button>` : ''}
      <label class="cf-l"><b>3</b> Агенты увидят</label>
      <div class="cf-pv" id="cn-preview">${cluePreview()}</div>
      <div class="cf-btns">
        ${mode === 'edit' ? `<button type="button" class="btn ghost" data-act="cn-edit-cancel">Отмена</button>` : ''}
        <button class="btn primary cf-go">${mode === 'edit' ? `${ic('check', 16)} Сохранить` : `${ic('send', 16)} Отправить`}</button>
      </div>
    </form>`;
  }

  function teamPanel(g, t) {
    const me = S.me;
    const myTeam = g.team[me];
    const cap = g.captain[t];
    const amCapHere = cap === me;
    const members = Object.keys(g.team).filter((id) => g.team[id] === t && id !== cap);
    const clues = (g.clues || []).filter((c) => c.team === t);
    const turn = g.turn === t && !g.winner && g.step !== 'setup';
    const prep = isPrep(g);
    const st = g.pst;
    const rd = (id) => (prep && g.ready[id] ? `<span class="rd" title="Готов">${ic('check', 11)}</span>` : '');
    const stat = (n, label, cls = '') => `<span class="ps ${cls}"><b>${n}</b>${label}</span>`;
    // Карточка капитана: статистика + все его подсказки
    const clueList = clues.length
      ? clues
          .map((c) => `<div class="hrow ${g.clue && g.clue.id === c.id && !g.winner ? 'now' : ''} ${c.slots.every((x) => x.done) ? 'alldone' : ''}"><span class="hword">${esc(c.word)}</span><span class="hnums">${clueChips(c, cap === me)}</span></div>`)
          .join('')
      : '<span class="muted small">подсказок ещё не было</span>';
    const capBlock = cap
      ? `<div class="pcard cap ${cap === me ? 'me' : ''} ${turn && g.step === 'clue' ? 'active' : ''}">
          <div class="pc-top"><span class="ava-wrap">${pa(cap, 'md', 'round')}${rd(cap)}</span><div class="pc-n"><span>${nm(cap)}</span><span class="tp-role">${ic('crown', 12)} капитан</span></div></div>
          ${st ? `<div class="pc-stats">${stat(clues.length, plural(clues.length, 'подсказка', 'подсказки', 'подсказок'))}${stat(st.capHits[cap] || 0, 'отгадали')}</div>` : ''}
          <div class="pc-clues">${clueList}</div>
          ${amCapHere && prep ? `<button class="btn tp-leave" data-act="cn-join" data-team="${t}">${ic('logout', 16)} Уступить место капитана</button>` : ''}
        </div>`
      : prep || !myTeam || myTeam === t
        ? `<button class="tp-become" data-act="cn-cap" data-team="${t}">${ic('crown', 18)}<span>Стать капитаном</span></button>`
        : `<div class="tp-empty muted small">${ic('crown', 14)} капитана нет</div>`;
    const agentCards = members
      .map(
        (id) => `<div class="pcard ${id === me ? 'me' : ''}">
          <div class="pc-top"><span class="ava-wrap">${pa(id, 'md', 'round')}${rd(id)}</span><div class="pc-n"><span>${nm(id)}${id === me ? ' <small class="muted">(вы)</small>' : ''}</span><span class="pc-role">агент</span></div></div>
          ${st ? `<div class="pc-stats">${stat(st.right[id] || 0, 'верно', 'ok')}${stat(st.wrong[id] || 0, 'мимо', 'bad')}${st.lead[id] ? stat(st.lead[id], 'первым') : ''}</div>` : ''}
        </div>`
      )
      .join('');
    return `<aside class="cn-side t-${t} ${turn ? 'turn' : ''}">
      ${(() => {
        const found = g.cards.filter((c) => c.revealed && c.color === t).length;
        const total = found + g.left[t];
        return `<div class="tp-top">
          <div class="tp-name-row"><span class="tp-name">${TN[t]}</span>${turn ? `<span class="tp-turn">${ic('clock', 13)} ${g.step === 'clue' ? 'капитан думает' : 'отгадывают'}</span>` : ''}</div>
          <div class="tp-count"><b data-cnt="cnl-${t}">${g.left[t]}</b><span>${plural(g.left[t], 'слово осталось', 'слова осталось', 'слов осталось')}<small>найдено ${found} из ${total}</small></span></div>
          <div class="tp-dots">${Array.from({ length: total }, (_, k) => `<i class="${k < found ? 'on' : ''}"></i>`).join('')}</div>
        </div>`;
      })()}
      <div class="tp-sec"><div class="tp-label">Капитан</div>${capBlock}</div>
      <div class="tp-sec"><div class="tp-label">Агенты · ${members.length}</div>
        <div class="tp-agents">${agentCards || '<span class="muted small">пока никого</span>'}</div>
      </div>
      ${myTeam !== t && (prep || !myTeam) ? `<button class="btn tp-join" data-act="cn-join" data-team="${t}">${ic('userplus', 18)} ${myTeam ? 'Перейти' : 'Играть'} за ${TNg[t]}</button>` : myTeam === t && !amCapHere ? `<div class="tp-in">${ic('check', 14)} Вы в этой команде</div>` : !prep && myTeam && myTeam !== t ? `<div class="tp-in muted">${ic('clock', 14)} Сменить команду можно после партии</div>` : ''}
    </aside>`;
  }

  // Колонка команды: панель + (для капитана, чей ход) форма подсказки под ней — центр с полем не меняется
  function sideCol(g, t) {
    const me = S.me;
    const amCapHere = g.captain[t] === me;
    let form = '';
    if (amCapHere && !g.winner && g.turn === t) {
      if (g.step === 'clue') form = clueForm(g, 'new');
      else if (g.step === 'guess' && ui.cnEdit && g.clue && g.clue.by === me && now() < g.clue.editUntil) form = clueForm(g, 'edit');
    }
    return `<div class="cn-col t-${t}">${teamPanel(g, t)}${form}</div>`;
  }

  // «Передать ход»: жмут все агенты; видно, кто уже нажал; когда все — 2 секунды и ход уходит
  function passBtn(g) {
    const mine = (g.passVotes || []).includes(S.me);
    const ids = g.agentIds || [];
    const pend = g.passPend;
    const el = pend ? Math.max(0, pend.ms - (pend.at - now())) : 0;
    return `<div class="cn-pass ${mine ? 'on' : ''} ${pend ? 'pending' : ''}">
      <button class="btn ${mine ? 'ja-on' : 'primary'} big-w cta-pass" data-act="cn-end">${pend ? `<span class="pend" style="--d:${pend.ms}ms;--e:-${el}ms">${ring('fill')}</span>` : ic('skip', 18)} ${pend ? 'Передаём ход… нажмите, чтобы отменить' : mine ? 'Вы за — отменить' : 'Передать ход'}</button>
      ${ids.length > 1 || mine ? `<span class="cn-pass-who" title="Кто нажал «Передать ход»">${ids.map((id) => `<span class="ava-wrap ${(g.passVotes || []).includes(id) ? 'on' : ''}">${pa(id, 26, 'round')}${(g.passVotes || []).includes(id) ? `<span class="rd">${ic('check', 10)}</span>` : ''}</span>`).join('')}<small>${(g.passVotes || []).length}/${ids.length}</small></span>` : ''}
    </div>`;
  }

  function rCodenames(g) {
    const me = S.me;
    const myTeam = g.team[me];
    const amCap = g.captain.red === me || g.captain.blue === me;
    const myTurn = myTeam === g.turn;
    const amAgentNow = myTurn && !amCap && !g.winner && g.step === 'guess';
    let status;
    if (isPrep(g)) {
      const pool = prepPool(g);
      const n = pool.filter((id) => g.ready[id]).length;
      const mine = !!g.ready[me];
      const head = g.winner
        ? `${ic('trophy', 18)} Победили ${TN[g.winner].toLowerCase()}${g.reason === 'assassin' ? ' — соперники открыли убийцу' : ''}`
        : 'Распределитесь по командам';
      status = `<div class="ready-box ${g.winner ? 't-' + g.winner : ''}">
        <div class="rb-txt">
          <b>${head}</b>
          <span class="muted small">${g.winner ? 'Можно поменять команду или уступить место капитана. ' : ''}Выберите роль и нажмите «Готов» — партия начнётся, когда готовы все.${g.needs.length ? ` <span class="warn-t">Не хватает: ${g.needs.join(', ')}</span>` : ''}</span>
          ${g.winner && g.summary ? `<button class="btn ghost sm sum-open" data-act="cn-sum">${ic('star', 15)} Итоги партии</button>` : ''}
          <span class="rb-list">${pool.map((id) => `<span class="ava-wrap ${g.ready[id] ? 'is-ready' : ''}" title="${nm(id)}${g.ready[id] ? ' — готов' : ''}">${pa(id, 'sm', 'round')}${g.ready[id] ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span>`).join('')}<span class="muted small">${n}/${pool.length}</span></span>
        </div>
        <div class="rb-actions">
          ${myTeam ? `<button class="btn ready-btn ${mine ? 'on' : ''}" data-act="cn-ready">${ic('check', 24)} ${mine ? 'Готов!' : 'Готов'}</button>` : `<span class="muted">Выберите команду слева или справа</span>`}
          ${isHost() ? `<button class="btn ghost rb-force" data-act="cn-force" title="Только для хоста: запустить партию, не дожидаясь «Готов» от всех">${ic('play', 16)} Начать без ожидания</button>` : ''}
        </div>
      </div>`;
    } else if (g.winner)
      status = `<div class="cn-clue t-${g.winner}"><div class="cl-main"><span class="cl-label">Партия окончена</span><span class="cl-word sm">${ic('trophy', 18)} Победили ${TN[g.winner].toLowerCase()}${g.reason === 'assassin' ? ' — соперники открыли убийцу' : ''}</span></div></div>`;
    else if (g.step === 'clue')
      status =
        amCap && myTurn
          ? `<div class="cn-clue t-${g.turn} cap-turn"><div class="cl-main"><span class="cl-label">Ваш ход, капитан</span><span class="cl-word sm">${ic(g.turn === 'red' ? 'back' : 'send', 18)} Напишите подсказку в панели ${g.turn === 'red' ? 'слева' : 'справа'}</span></div></div>`
          : `<div class="cn-clue t-${g.turn}"><div class="cl-main"><span class="cl-label">Ход ${TNg[g.turn]}</span><span class="cl-word sm muted">${g.captain[g.turn] ? `${nm(g.captain[g.turn])} придумывает подсказку…` : 'Нужен капитан — нажмите «Стать капитаном» в панели команды'}</span></div></div>`;
    else {
      const c = g.clue;
      const canEdit = c.by === me && now() < c.editUntil;
      status = `<div class="cn-clue t-${g.turn}">
        <div class="cl-main"><span class="cl-label">Подсказка от ${nm(c.by)}</span><span class="cl-word">${esc(c.word)}</span></div>
        <div class="cl-nums">${clueChips(c, g.captain[c.team] === me)}</div>
        ${canEdit ? `<button class="btn sm edit-btn" data-act="cn-edit" data-until="${c.editUntil}" data-span="15000" title="Можно исправить в течение 15 секунд">${ring('', 100 - ((c.editUntil - now()) / 15000) * 100)}<span>${ic('pencil', 14)} Исправить</span><span class="secs">${Math.ceil((c.editUntil - now()) / 1000)}</span></button>` : ''}
        ${amAgentNow ? passBtn(g) : ''}
      </div>
      ${(g.passVotes || []).length && !amAgentNow ? `<p class="cn-pass-note small">${ic('skip', 14)} ${TN[g.turn]} хотят передать ход: ${g.passVotes.length}/${g.agentIds.length}</p>` : ''}
      <p class="cn-wait small muted">${amAgentNow ? `Кликните по карточке, чтобы проголосовать. Когда все агенты (${g.agentsNow}) выберут одну — через 2 секунды она откроется.` : myTurn && amCap ? 'Ваша команда выбирает карточки' : `Отгадывают ${TNg[g.turn]}`}</p>`;
    }

    // Капитанский вид «по цветам»: свои → соперники → нейтральные → убийца (пока наведена кнопка)
    const canSort = amCap && g.step !== 'setup' && !g.winner;
    if (!canSort) ui.cnSort = false;
    if (canSort) {
      const other = myTeam === 'red' ? 'blue' : 'red';
      const sw = (t) => `<i style="background:var(--cn-${t})"></i>`;
      const sortBtn = `<button type="button" class="cn-sort ${ui.cnSort ? 'on' : ''}" data-cn-sort aria-pressed="${!!ui.cnSort}" title="Наведите — карточки встанут по цветам: ваши, соперников, нейтральные, убийца">
          <span class="cs-sw">${sw(myTeam)}${sw(other)}${sw('neu')}${sw('ass')}</span><span class="cs-t"><b>По цветам</b><small>${matchMedia('(hover: hover)').matches ? 'наведите' : 'нажмите'}</small></span></button>`;
      status = status.replace('<div class="cl-main">', sortBtn + '<div class="cl-main">');
    }
    const cards = g.cards
      .map((c, i) => {
        const pend = g.pending && g.pending.i === i;
        const elapsed = pend ? Math.max(0, g.pending.ms - (g.pending.at - now())) : 0;
        if (g.step === 'setup') return `<div class="cn-card blank" style="--i:${i}">${ic('grid', 18)}</div>`;
        return `<button class="cn-card ${c.color ? 'c-' + c.color : ''} ${c.revealed ? 'rev' : ''} ${c.marks.includes(me) ? 'mine' : ''} ${pend ? 'pending' : ''} ${ui.flip && ui.flip.has(i) ? 'flip' : ''} ${ui.enter && g.step === 'clue' ? 'deal' : ''}" style="--i:${i};${ui.flip && ui.flip.has(i) ? `--fd:-${Date.now() - ui.flip.get(i)}ms` : ''}${ui.cnSort ? `;order:${cnRank(c, i, myTeam)}` : ''}" data-act="cn-mark" data-i="${i}">
          <span class="w ${/\s/.test(c.w) ? 'phrase' : ''}" lang="ru">${hy(c.w)}</span>
          ${c.color ? `<i class="cb-mark" aria-hidden="true">${{ red: '▲', blue: '●', neutral: '–', assassin: '✕' }[c.color] || ''}</i>` : ''}
          ${c.marks.length ? `<span class="marks">${c.marks.map((m) => pa(m, 'xs')).join('')}</span>` : ''}
          ${pend ? `<span class="pend" style="--d:${g.pending.ms}ms;--e:-${elapsed}ms">${ring('fill')}</span>` : ''}
        </button>`;
      })
      .join('');
    const glow = !g.winner && g.step !== 'setup' ? `<div class="turn-glow g-${g.turn}" aria-hidden="true"></div>` : '';
    return `${glow}
      <div class="cn">
        ${sideCol(g, 'red')}
        <section class="cn-center">
          <div class="cn-status">${status}</div>
          <div class="cn-board ${amCap ? 'captain own-' + myTeam : ''} ${amCap || g.winner ? 'allcolors' : ''} ${ui.cnSort ? 'sorted' : ''}">${cards}</div>
          <details class="log card"><summary>${ic('list', 16)} Журнал ходов</summary>${g.log
            .slice()
            .reverse()
            .map(
              (l) =>
                `<div class="log-i ${l.team}">${
                  l.kind === 'clue'
                    ? `${ic('chat', 14)} ${esc(l.by)}: <b>${esc(l.text)}</b>`
                    : l.kind === 'edit'
                      ? `${ic('pencil', 14)} ${esc(l.by)} исправил: <b>${esc(l.text)}</b>`
                      : l.kind === 'pass'
                        ? `${ic('skip', 14)} ${esc(l.by)} передал ход`
                        : l.kind === 'overtime'
                          ? `${ic('clock', 14)} ${esc(l.by)}: капитан думает за счёт времени команды`
                          : l.kind === 'timeout'
                          ? `${ic('clock', 14)} ${esc(l.by)}: время вышло`
                          : `${ic('grid', 14)} ${esc(l.by)} открыли <b>${esc(l.text)}</b> <span class="sw c-${l.color}"></span>`
                }</div>`
            )
            .join('') || '<div class="muted small">Пока пусто</div>'}</details>
        </section>
        ${sideCol(g, 'blue')}
      </div>`;
  }

  // ===== Элиас: команды по бокам, слово и две большие кнопки по центру =====
  function aliasTeam(g, i) {
    const t = g.teams[i];
    const turn = i === g.turnTeam && !['teams', 'over'].includes(g.phase);
    return `<aside class="side-team ${turn ? 'turn' : ''} ${i === g.myTeam ? 'mine' : ''}" style="--tc:${ALIAS_BG[i]}">
      <div class="tp-head"><span class="tp-name">${esc(t.name)}</span><span class="tp-left">${g.live && g.live[i] ? `<em class="al-live ${g.live[i] > 0 ? 'up' : 'down'}">${g.live[i] > 0 ? '+' : ''}${g.live[i]}</em>` : ''}<b data-cnt="als-${i}">${t.score + ((g.live && g.live[i]) || 0)}</b><small>из ${g.target}</small></span></div>
      ${turn ? `<div class="tp-turn">${ic('mic', 14)} Ход команды</div>` : ''}
      <div class="tp-agents">${
        t.members.map((id) => `<div class="tp-agent ${id === S.me ? 'me' : ''}">${pa(id, 'sm')}<span>${nm(id)}</span>${id === g.explainer && turn ? `<span class="tp-role">${ic('mic', 12)} объясняет</span>` : ''}</div>`).join('') ||
        '<span class="muted small">пока никого</span>'
      }</div>
      ${g.phase === 'teams' && i !== g.myTeam ? `<button class="btn tp-join" data-act="al-join" data-team="${i}">${ic('userplus', 18)} В эту команду</button>` : i === g.myTeam ? `<div class="tp-in">${ic('check', 14)} Вы в этой команде</div>` : ''}
    </aside>`;
  }

  // Колода слов Элиаса: верхняя карточка + стопка под ней. Угадали — карточка улетает вверх-вправо зелёной,
  // пропуск — влево красной, следующая поднимается из стопки. Время анимации считаем от момента смены,
  // чтобы перерисовки её не перезапускали.
  function aliasStack(g) {
    const turn = g.explainer + ':' + g.turnTeam + ':' + (g.endsAt || '');
    const k = (g.guessedNow || 0) + (g.skippedNow || 0);
    const p = ui.al;
    if (!p || p.turn !== turn) ui.al = { turn, k, g: g.guessedNow || 0, w: g.word, out: null };
    else if (k > p.k) {
      ui.al = { turn, k, g: g.guessedNow || 0, w: g.word, out: { w: p.w, kind: (g.guessedNow || 0) > p.g ? 'got' : 'skip', at: Date.now() } };
    } else if (k === p.k) p.w = g.word;
    const o = ui.al.out;
    const el = o ? Date.now() - o.at : 1e9;
    const face = (w) => (w ? `<span class="al-w">${esc(w)}</span>` : `<span class="al-w q">?</span>`);
    return `<div class="al-stack ${g.word ? '' : 'hid'}" style="--oe:${Math.min(el, 5000)}ms">
      <div class="al-back b3"></div><div class="al-back b2"></div><div class="al-back b1"></div>
      <div class="al-card top ${o && el < 1500 ? 'enter' : ''}">${face(g.word)}<span class="al-n">${k + 1}</span></div>
      ${o && el < 1500 ? `<div class="al-card out ${o.kind}">${face(o.w)}<span class="al-stamp">${o.kind === 'got' ? ic('check', 18) + ' +1' : ic('x', 18) + ' пропуск'}</span></div>` : ''}
    </div>`;
  }

  function rAlias(g) {
    const me = S.me;
    const isExpl = g.explainer === me;
    const team = g.teams[g.turnTeam];
    let center = '';
    if (g.phase === 'teams') {
      center = `<div class="stage-card">
        <div class="big-ic">${ic('hat', 44)}</div>
        <h2 class="h2">Разбейтесь на команды</h2>
        <p class="muted">Нажмите «В эту команду» в панели слева или справа. Нужно минимум две непустые команды, лучше по двое.</p>
        ${isHost() ? `<div class="row c"><button class="btn ghost big-w" data-act="al-shuffle">${ic('shuffle', 18)} Перемешать</button><button class="btn primary big-w" data-act="al-begin">${ic('play', 18)} Начать игру</button></div>` : '<p class="muted">Хост начнёт игру, когда все распределятся.</p>'}
      </div>`;
    } else if (g.phase === 'ready') {
      center = `<div class="stage-card">
        <div class="kicker" style="color:${ALIAS_BG[g.turnTeam]}">Ход команды «${esc(team.name)}»</div>
        <div class="expl">${pa(g.explainer, 96)}<h2 class="h2">Объясняет ${nm(g.explainer)}</h2></div>
        ${isExpl ? `<button class="btn primary mega" data-act="al-go">${ic('play', 26)} Поехали!</button><p class="muted">У вас ${g.seconds} секунд.</p>` : `<p class="muted">Ждём, когда ${nm(g.explainer)} нажмёт «Поехали».</p>`}
      </div>`;
    } else if (g.phase === 'running') {
      center = `<div class="stage-card run">
        ${aliasStack(g)}${g.word ? '' : `<p class="muted">Слушайте ${nm(g.explainer)} и угадывайте!</p>`}
        ${isExpl ? `<div class="mega-row"><button class="btn danger mega" data-act="al-skip">${ic('x', 26)} Пропуск${g.penalty ? ' −1' : ''}</button><button class="btn success mega" data-act="al-got">${ic('check', 26)} Угадали +1</button></div>` : ''}
        <div class="counters"><span>Угадано <b data-cnt="alg">${g.guessedNow}</b></span><span>Пропущено <b data-cnt="alk">${g.skippedNow}</b></span></div>
      </div>`;
    } else if (g.phase === 'review') {
      // Слова и «кто угадал последнее» отмечает только объясняющий; очки подтверждают все
      const exOff = player(g.explainer)?.connected === false;
      const canMark = isExpl || (isHost() && exOff);
      const lastLabel = (w) => (w.ok === 'own' ? 'угадала своя команда' : typeof w.ok === 'number' ? `угадали «${esc(g.teams[w.ok].name)}»` : 'никто не угадал');
      center = `<div class="stage-card left">
        <div class="kicker">Проверка слов · команда «${esc(team.name)}»</div>
        ${(() => {
          // Последнее слово — кто его угадал? Сразу кнопки команд их цветами
          const lw = g.turnWords.find((w) => w.last);
          if (!lw) return '';
          const cur = lw.ok === 'own' ? g.turnTeam : typeof lw.ok === 'number' ? lw.ok : lw.set ? 'none' : null;
          const order = [g.turnTeam, ...g.teams.map((_, i) => i).filter((i) => i !== g.turnTeam)];
          if (!canMark) return `<div class="al-last ${lw.set ? 'done' : ''} ro"><div class="al-last-h"><span class="muted">Последнее слово</span><b>«${esc(lw.w)}»</b><span class="muted">${lw.set ? `— ${cur === 'none' ? 'никто не угадал' : `угадали «${esc(g.teams[cur].name)}»`}` : `— ${nm(g.explainer)} отметит, кто угадал`}</span></div></div>`;
          return `<div class="al-last ${lw.set ? 'done' : ''}">
            <div class="al-last-h"><span class="muted">Последнее слово</span><b>«${esc(lw.w)}»</b><span class="muted">— кто угадал?</span></div>
            <div class="al-last-b">${order
              .map((i) => `<button class="al-tb ${cur === i ? 'on' : ''}" style="--tc:${ALIAS_BG[i]}" data-act="al-last" data-to="${i}">${cur === i ? ic('check', 16) : ''}${esc(g.teams[i].name)}${i === g.turnTeam ? ' <small>(своя)</small>' : ''}</button>`)
              .join('')}<button class="al-tb none ${cur === 'none' ? 'on' : ''}" data-act="al-last" data-to="none">${cur === 'none' ? ic('check', 16) : ''}Никто</button></div>
          </div>`;
        })()}
        <p class="small muted">${canMark ? 'Нажмите на слово, чтобы поменять статус.' : `Слова отмечает ${nm(g.explainer)}.`} Угадано +1${g.penalty ? ', пропуск −1' : ''}.</p>
        ${(() => {
          const ok = g.turnWords.filter((w) => w.ok === true || w.ok === 'own').length;
          const no = g.turnWords.filter((w) => !w.last && (w.ok === false || w.ok === null || w.ok === undefined)).length;
          const pts = (g.live && g.live[g.turnTeam]) ?? ok - (g.penalty ? no : 0); // как посчитает сервер: последнее слово без штрафа
          return `<div class="rv-sum"><span class="ok">${ic('check', 14)} ${ok} угадано</span><span class="no">${ic('x', 14)} ${no} ${g.penalty ? 'пропуск' : 'мимо'}</span><b>${pts > 0 ? '+' : ''}${pts} ${plural(Math.abs(pts), 'очко', 'очка', 'очков')}</b></div>`;
        })()}
        <div class="review">${
          g.turnWords
            .map(
              (w, i) => `<button class="rw ${w.last ? 'last' : ''} ${w.ok === true || w.ok === 'own' ? 'ok' : typeof w.ok === 'number' ? 'other' : 'no'} ${canMark ? '' : 'ro'}" ${canMark ? `data-act="al-toggle" data-i="${i}"` : 'tabindex="-1"'}>
            <span class="rw-ic">${w.ok === true || w.ok === 'own' ? ic('check', 18) : typeof w.ok === 'number' ? ic('swap', 18) : ic('x', 18)}</span>
            <span class="rw-w">${esc(w.w)}</span><em>${w.last ? 'последнее: ' + lastLabel(w) : w.ok ? '+1' : g.penalty ? '−1' : '0'}</em></button>`
            )
            .join('') || '<p class="muted">Ни одного слова</p>'
        }</div>
        ${(() => {
          const ids = g.confirmers || [];
          const done = g.confirms || [];
          const mine = done.includes(me);
          const inTeam = g.myTeam !== -1 && g.myTeam != null;
          return `<div class="rv-cta">
            ${inTeam ? `<button class="btn ${mine ? 'ja-on' : 'primary'} mega" data-act="al-confirm">${mine ? `${ic('check', 20)} Подтвердили — ждём остальных` : `${ic('check', 20)} Подтвердить очки`}</button>` : ''}
            <div class="jo-ready nx-who"><span class="muted small">Подтвердили ${done.length}/${ids.length}${done.length ? '' : ' — игра продолжится, когда нажмут все'}</span><span class="jr-list">${ids.map((id) => `<span class="jr ${done.includes(id) ? 'on' : ''}"><span class="ava-wrap">${pa(id, 34, 'round')}${done.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span><small>${nm(id)}</small></span>`).join('')}</span></div>
          </div>`;
        })()}
      </div>`;
    } else if (g.phase === 'over') {
      center = `<div class="stage-card"><div class="big-ic">${ic('trophy', 56)}</div><h2 class="h2">Победила команда «${esc(g.teams[g.winner].name)}»!</h2>
        ${canRestart() ? `<button class="btn primary big-w" data-act="al-restart">${ic('reset', 18)} Сыграть ещё</button>` : ''}</div>`;
    }
    const left = g.teams.map((_, i) => i).filter((i) => i % 2 === 0);
    const right = g.teams.map((_, i) => i).filter((i) => i % 2 === 1);
    return `<div class="tri">
      <div class="tri-side">${left.map((i) => aliasTeam(g, i)).join('')}</div>
      <section class="tri-center">${center}</section>
      <div class="tri-side">${right.map((i) => aliasTeam(g, i)).join('')}</div>
    </div>`;
  }

  // ===== Шпион =====
  function rSpy(g) {
    const me = S.me;
    const over = g.phase === 'over';
    const guessing = g.phase === 'guessing';
    let card;
    if (!g.inGame && !over) card = `<div class="spy-card watch">Вы наблюдаете этот раунд. В следующем раунде вы получите карточку.</div>`;
    else if (over)
      card = `<div class="spy-card result ${g.result?.winner === 'spy' ? 'spywin' : g.result?.winner === 'town' ? 'townwin' : ''}">
        <div class="kicker">Раунд ${g.round} окончен</div><h2>${esc(g.result?.text || '')}</h2>
        <p>Локация: <b>${esc(g.location)}</b> · ${g.spies.length > 1 ? 'Шпионы' : 'Шпион'}: <b>${g.spies.map(nm).join(', ')}</b></p>
        <div class="roles">${g.participants.filter((id) => !g.spies.includes(id)).map((id) => `<span class="chip">${pa(id, 'xs')}${nm(id)} — ${esc(g.roles[id])}</span>`).join('')}</div>
      </div>`;
    else
      card = `<button class="spy-card ${g.isSpy ? 'spy' : ''} ${ui.hideCard ? 'covered' : ''}" data-act="spy-hide">
        ${
          ui.hideCard
            ? `<div class="cover">${ic('eye', 20)} Нажмите, чтобы показать карточку</div>`
            : g.isSpy
              ? `<div class="kicker">Ваша роль</div><h2>${ic('spy', 32)} Вы — шпион</h2><p>Узнайте локацию по вопросам и ответам${g.spyCount > 1 ? `. Шпионов в игре: ${g.spyCount}` : ''}.</p>`
              : `<div class="kicker">Локация</div><h2>${esc(g.location)}</h2><p>Ваша роль: <b>${esc(g.role)}</b></p>`
        }
        ${ui.hideCard ? '' : `<span class="hint">${ic('eyeoff', 12)} нажмите, чтобы скрыть</span>`}
      </button>`;

    let claim = '';
    if (guessing) {
      const c = g.claim;
      const townIds = g.participants.filter((id) => id !== c.by && player(id));
      const yes = townIds.filter((id) => c.judges[id] === true).length;
      const no = townIds.filter((id) => c.judges[id] === false).length;
      const need = Math.floor(townIds.length / 2) + 1;
      const amJudge = g.inGame && me !== c.by && !g.isSpy;
      claim = `<div class="card center big-pad claim">
        <div class="kicker">Шпион раскрылся</div>
        <h2 class="h2">${ic('target', 24)} ${nm(c.by)} называет локацию</h2>
        ${me === c.by ? '<p>Говорите вслух в Discord — участники подтвердят.</p>' : '<p class="muted">Слушайте в Discord и решите, угадал ли он.</p>'}
        ${amJudge ? `<div class="row c"><button class="btn ${c.judges[me] === false ? 'danger' : 'ghost'}" data-act="spy-judge" data-ok="0">${ic('x', 16)} Не угадал</button><button class="btn ${c.judges[me] === true ? 'success' : 'ghost'}" data-act="spy-judge" data-ok="1">${ic('check', 16)} Шпион правильно ответил</button></div>` : ''}
        <p class="small muted">Угадал: <b>${yes}</b> · Не угадал: <b>${no}</b> · нужно ${need} из ${townIds.length}</p>
      </div>`;
    }

    // Очередь вопросов
    const playing = g.phase === 'play';
    const alive = g.participants.filter((id) => player(id));
    const totalQ = g.qlog.length;
    // «Молчун»: вопросов было уже немало, а этому игроку — ни одного
    const quiet = (id) => playing && totalQ >= Math.max(2, Math.ceil(alive.length / 2)) && !(g.asked[id] || 0);
    const canPick = playing && (me === g.asker || isHost()) && g.inGame;
    const turnBox = playing && g.asker
      ? `<div class="card spy-turn">
          ${
            g.target
              ? `<div class="st-pair">${pa(g.asker, 44, 'round')}<span class="st-arrow">${ic('chat', 18)}</span>${pa(g.target, 44, 'round')}</div>
                 <div class="st-txt"><b>${nm(g.asker)}</b> спрашивает <b>${nm(g.target)}</b></div>
                 ${me === g.target || me === g.asker || isHost() ? `<button class="btn primary big-w" data-act="spy-answered">${ic('check', 18)} ${me === g.target ? 'Ответил — теперь я спрашиваю' : 'Ответил — дальше'}</button>` : ''}`
              : `<div class="st-pair">${pa(g.asker, 44, 'round')}</div>
                 <div class="st-txt">${me === g.asker ? '<b>Ваш вопрос.</b> Выберите в списке игроков, кого спросить' : `Спрашивает <b>${nm(g.asker)}</b> — выбирает, кого`}</div>`
          }
        </div>`
      : '';
    // Игроки — слева карточками: сколько раз спрашивали, кто обвиняет, кнопки «Спросить» и «Обвинить»
    const players = g.participants
      .map((id, i) => {
        const voters = Object.keys(g.votes).filter((v) => g.votes[v] === id);
        const pickable = canPick && !g.target && id !== g.asker && player(id) && !(id === g.prev && alive.length > 2);
        const st = playing && id === g.asker ? (g.target ? 'спрашивает' : 'выбирает, кого спросить') : playing && id === g.target ? 'отвечает' : '';
        return `<div class="sp ${g.votes[me] === id ? 'my' : ''} ${quiet(id) ? 'quiet' : ''} ${st ? 'in-q' : ''} ${over && g.spies.includes(id) ? 'was-spy' : ''} ${id === me ? 'me' : ''}" style="--i:${i}">
          <div class="sp-ava">${pa(id, 52, 'round')}${over && g.spies.includes(id) ? `<span class="sp-spy">${ic('spy', 14)}</span>` : ''}</div>
          <div class="sp-body">
            <span class="sp-name">${nm(id)}${id === me ? ' <small>(вы)</small>' : ''}</span>
            <span class="sp-meta">${
              over
                ? g.spies.includes(id) ? '<b class="sp-tag spy">шпион</b>' : `<span class="muted">${esc(g.roles[id] || '')}</span>`
                : `${playing ? `<span class="qcnt" title="Сколько вопросов задали этому игроку">${ic('chat', 12)} ${g.asked[id] || 0}</span>` : ''}${st ? `<b class="sp-tag">${st}</b>` : quiet(id) ? '<b class="sp-tag warn">ещё не спрашивали</b>' : ''}`
            }</span>
            ${voters.length ? `<span class="sp-voters" title="Кто обвиняет">${ic('target', 12)} ${voters.map((v) => pa(v, 'xs', 'round')).join('')}<small>${voters.length}</small></span>` : ''}
          </div>
          <div class="sp-acts">
            ${pickable ? `<button class="btn xs primary" data-act="spy-ask" data-pid="${id}">${ic('chat', 13)} Спросить</button>` : ''}
            ${g.phase === 'play' && g.inGame && id !== me ? `<button class="btn xs ${g.votes[me] === id ? 'danger' : 'ghost'}" data-act="spy-vote" data-pid="${id}">${g.votes[me] === id ? 'Отозвать' : 'Обвинить'}</button>` : ''}
          </div>
        </div>`;
      })
      .join('');
    // История: кто кого спрашивал — с аватарками, свежие сверху
    const hist = g.qlog.length
      ? `<div class="card spy-hist"><div class="side-h">${ic('list', 16)} Кто кого спрашивал <span class="muted small">${g.qlog.length}</span></div>
          <div class="sh-list" data-scroll="spy-hist">${g.qlog
            .map((q, i) => ({ ...q, n: i + 1 }))
            .reverse()
            .slice(0, 30)
            .map((q, i) => `<div class="sh-row ${i === 0 ? 'last' : ''}"><span class="sh-n">${q.n}</span><span class="sh-p">${pa(q.from, 28, 'round')}<b>${nm(q.from)}</b></span><span class="sh-arrow">${ic('chat', 14)}</span><span class="sh-p">${pa(q.to, 28, 'round')}<b>${nm(q.to)}</b></span></div>`)
            .join('')}</div></div>`
      : '';

    const roundTable = over
      ? `<div class="card"><div class="side-h">Очки за раунд</div>${g.participants
          .map((id) => {
            const r = g.roundPts[id];
            return `<div class="pts-row"><span>${who(id, 'sm')}</span><span class="why small muted">${r ? esc(r.why.join(', ')) : '—'}</span><b class="${r?.pts ? 'plus' : ''}">${r?.pts ? '+' + r.pts : 0}</b></div>`;
          })
          .join('')}</div>`
      : '';
    const score = Object.entries(g.score);
    const votedN = Object.keys(g.votes).length;
    return `<div class="spyfall spy2 ${ui.enter ? 'enter' : ''}">
      <aside class="spy-players" data-scroll="spy-players">
        <div class="side-h">${ic('users', 16)} Игроки <span class="muted small">${playing ? `обвинение — нужны голоса всех остальных${votedN ? ` · голосов ${votedN}` : ''}` : ''}</span></div>
        <div class="sp-list">${players}</div>
        ${score.length && score.some(([, n]) => n) ? `<div class="sp-score"><div class="side-h">Общий счёт</div>${leaderboard(score)}</div>` : ''}
      </aside>
      <div class="spy-main">
        <div class="spy-top"><span class="muted">Раунд ${g.round}</span></div>
        ${card}
        ${over && canRestart() ? `<div class="row c"><button class="btn primary mega" data-act="spy-next">${ic('play', 20)} Следующая игра</button></div>` : over ? '<p class="center muted">Ждём, пока хост начнёт следующую игру</p>' : ''}
        ${g.phase === 'play' && g.isSpy ? `<div class="spy-claim-row"><button class="btn primary big-w" data-act="spy-claim">${ic('target', 18)} Я знаю локацию</button><span class="small muted">Нажмите и назовите локацию вслух — мирные решат, угадали ли вы</span></div>` : ''}
        ${claim}
        ${guessing ? '' : turnBox}
        ${roundTable}
        ${hist}
      </div>
    </div>`;
  }

  // ===== Кто я: сетка как в звонке, заметки, большие кнопки внизу =====
  // Частые вопросы для «Кто я?» — от общего к частному
  const WHO_SUGG = [
    'Я реальный человек?', 'Я вымышленный персонаж?', 'Я мужчина?', 'Я женщина?', 'Я человек?', 'Я животное?', 'Я жив сейчас?',
    'Я из фильма?', 'Я из мультфильма?', 'Я из сериала?', 'Я из книги?', 'Я из видеоигры?', 'Я из аниме?', 'Я из сказки?',
    'Я знаменит на весь мир?', 'Я из Украины?', 'Я из США?', 'Я из Европы?', 'Я жил до 1900 года?', 'Мне больше 50 лет?',
    'Я актёр?', 'Я музыкант или певец?', 'Я спортсмен?', 'Я политик?', 'Я учёный или изобретатель?', 'Я блогер или ведущий?',
    'Я супергерой?', 'Я злодей?', 'У меня есть суперсилы?', 'Я умею летать?', 'Я ношу очки?', 'У меня есть борода или усы?',
    'Я связан с комедией?', 'Я персонаж Disney или Pixar?', 'Я персонаж Marvel или DC?',
  ];

  function rWho(g) {
    const me = S.me;
    if (!g.inGame) return `<div class="narrow"><div class="stage-card"><p>Игра уже идёт.</p><button class="btn primary mega" data-act="who-add">Присоединиться со случайным персонажем</button></div></div>`;
    if (g.phase === 'write') {
      return `<div class="narrow who-write-wrap"><div class="stage-card">
        ${
          g.writeFor
            ? `<div class="kicker">Загадайте персонажа</div><div class="expl">${pa(g.writeFor, 96)}<h2 class="h2">для ${nm(g.writeFor)}</h2></div>
               ${
                 g.writtenForTarget
                   ? `<p class="jo-sent">${ic('check', 18)} Персонаж загадан — ждём остальных</p>`
                   : `<form data-form="who-write" class="who-write"><div class="big-form"><input class="inp big-inp" name="text" data-keep="who-write" maxlength="60" placeholder="Персонаж или известный человек" autocomplete="off" required/><button class="btn primary mega">Загадать</button></div>
                 <div class="ww-img">${
                   ui.whoImg
                     ? `<span class="ww-prev"><img src="${esc(ui.whoImg.prev)}" alt=""><button type="button" class="ww-x" data-act="who-img-x" title="Убрать картинку">${ic('x', 13)}</button></span><span class="muted small">${ui.whoImg.url ? `${ic('check', 14)} Картинка прикреплена — её увидят все, кроме ${nm(g.writeFor)}` : 'Загружаем картинку…'}</span>`
                     : `<button type="button" class="btn ghost ww-add" data-act="who-img">${ic('camera', 18)} Прикрепить картинку</button><span class="muted small">необязательно · можно вставить из буфера (Ctrl+V)</span>`
                 }</div></form>
               <button class="link-btn" data-act="who-random">или выбрать случайного</button>`
               }`
            : '<p>Ждём остальных…</p>'
        }
      </div>
      ${(() => {
        // Кто уже загадал, а кто ещё думает — чтобы было видно, кого ждём
        const ws = new Set(Object.values(g.players || {}).map((p) => p.writer).filter(Boolean));
        const writers = g.order.filter((id) => ws.has(id) && player(id));
        const done = writers.filter((id) => !g.pending.includes(id));
        return `<div class="card who-wait">
          <div class="side-h">${ic('users', 16)} Загадали ${done.length} из ${writers.length}${g.pending.length ? ` <span class="muted small">— ждём ${g.pending.length === 1 ? nm(g.pending[0]) : g.pending.length + ' ' + plural(g.pending.length, 'игрока', 'игроков', 'игроков')}</span>` : ''}</div>
          <div class="ww-list">${[...writers]
            .sort((a, b) => g.pending.includes(b) - g.pending.includes(a))
            .map((id) => {
              const wait = g.pending.includes(id);
              return `<div class="ww-p ${wait ? 'wait' : 'done'} ${id === me ? 'me' : ''}"><span class="ava-wrap">${pa(id, 44, 'round')}${wait ? '' : `<span class="rd">${ic('check', 12)}</span>`}</span><b>${nm(id)}${id === me ? ' <small>(вы)</small>' : ''}</b><small>${wait ? '<span class="ww-dots"><i></i><i></i><i></i></span> думает' : 'загадал'}</small></div>`;
            })
            .join('')}</div>
        </div>`;
      })()}
      </div>`;
    }
    const over = g.phase === 'over';
    const myState = g.players[me];
    const tiles = g.order
      .filter((id) => g.players[id])
      .map((id) => {
        const p = g.players[id];
        const isMe = id === me;
        const place = g.finishOrder.indexOf(id);
        const speaking = g.turnPid === id && !over;
        // кубок первому угадавшему, серебро второму, бронза третьему
        const medal = p.guessed && place >= 0 && place < 3 ? `<span class="wt-medal m${place + 1}" title="${['Первым угадал', 'Второе место', 'Третье место'][place]}">${ic(place === 0 ? 'trophy' : 'medal', place === 0 ? 20 : 17)}</span>` : '';
        // Идёт вопрос: кто уже ответил (галочка цветом ответа), а кто ещё нет — чтобы подтолкнуть
        const curQ = !over && g.q && g.q.asker === g.turnPid ? g.q : null;
        const ans = curQ && id !== g.turnPid ? curQ.who[id] || null : undefined;
        const ansBadge = ans === undefined ? '' : ans ? `<span class="wt-ans a-${ans}" title="Ответил">${ans === 'no' ? ic('x', 13) : ans === 'idk' ? '<b>?</b>' : ic('check', 13)}</span>` : `<span class="wt-ans wait" title="Ещё не ответил"><i></i><i></i><i></i></span>`;
        return `<div class="wt ${speaking ? 'speaking' : ''} ${p.guessed ? 'done' : ''} ${p.gaveUp ? 'gaveup' : ''} ${isMe ? 'me' : ''} ${ans === null ? 'slow' : ''}">
          <div class="wt-ava">${pa(id, 84, 'round')}${medal}${ansBadge}</div>
          <div class="wt-body">
            <span class="wt-name">${speaking ? `<span class="wt-mic">${ic('mic', 12)}</span>` : ''}${nm(id)}${isMe ? ' <small>(вы)</small>' : ''}</span>
            <div class="wt-char ${p.char ? '' : 'hidden-char'}">${p.char ? esc(p.char) : `${ic('question', 16)} это вы`}</div>
            <span class="wt-st">${p.guessed ? `${ic('check', 13)} угадал${place >= 0 ? ` #${place + 1}` : ''} · +${g.points[id]}` : p.gaveUp ? 'сдался' : speaking ? 'спрашивает' : ans === null ? '<b class="wt-slow">ещё не ответил</b>' : ans ? `<span class="wt-did">ответил${ans === 'yes' ? ' «да»' : ans === 'no' ? ' «нет»' : ' «не знаю»'}</span>` : ''}</span>
          </div>
          ${p.img ? `<img class="wt-img" src="${esc(p.img)}" alt="" decoding="sync">` : ''}
        </div>`;
      })
      .join('');
    const notesKey = `pg_notes_${S.room.code}`;
    // Вопросы «да/нет»: спрашивающий печатает (или говорит голосом), остальные отвечают кнопками
    const AL = { yes: 'Да', no: 'Нет', idk: 'Не знаю' };
    const qaCard = (x, live = false) =>
      `<div class="qa-c v-${live ? 'live' : x.v || 'idk'}">
        <div class="qa-c-q">${x.text ? esc(x.text) : '<i>вопрос голосом</i>'}</div>
        <div class="qa-c-a">${live ? '<span class="qa-c-v">ждём ответы…</span>' : `<span class="qa-c-v">${AL[x.v] || '—'}</span>`}<span class="qa-c-n"><i class="y">${x.yes}</i><i class="n">${x.no}</i><i>${x.idk}</i></span></div>
      </div>`;
    // «Мои вопросы и ответы» — по порядку, как задавались: номер, вопрос, итог цветной меткой
    // Вопросы раскладываем в две колонки: «Да» и «Нет»; спорные («не знаю», поровну) — отдельной строкой ниже
    const qaCards = (list, extra = '') => {
      if (!list.length) return '<span class="muted small">Вопросов пока не было</span>';
      const all = list.map((x, i) => ({ ...x, n: i + 1 }));
      const item = (x) => `<div class="qa-it"><span class="ql-n">${x.n}</span><span class="ql-q">${esc(x.text)}</span><span class="ql-c" title="да / нет / не знаю"><i class="y">${x.yes}</i> <i class="n">${x.no}</i> <i>${x.idk}</i></span></div>`;
      const col = (v, title) => {
        const xs = all.filter((x) => x.v === v);
        return `<div class="qa-col c-${v}"><div class="qa-col-h"><b>${title}</b><span>${xs.length}</span></div>${xs.map(item).join('') || '<span class="qa-empty">пока ничего</span>'}</div>`;
      };
      const rest = all.filter((x) => x.v !== 'yes' && x.v !== 'no');
      return `<div class="qa-cols">${col('yes', 'Да')}${col('no', 'Нет')}</div>${rest.length ? `<div class="qa-col c-idk"><div class="qa-col-h"><b>Не ясно</b><span>${rest.length}</span></div>${rest.map(item).join('')}</div>` : ''}${extra ? `<div class="qa-grid">${extra}</div>` : ''}`;
    };
    const q = g.q && g.q.asker === g.turnPid ? g.q : null;
    const asker = g.turnPid;
    const qVotes = (v) => (q ? Object.entries(q.who).filter(([, a]) => a === v).map(([id]) => `<span title="${nm(id)}">${pa(id, 'xs', 'round')}</span>`).join('') : '');
    const myQa = g.players[me]?.qa || [];
    let qBox = '';
    if (!over && asker === me) {
      // Мой ход: большое поле вопроса по центру, ниже — история карточками
      qBox = `<div class="card who-ask">
          <div class="wa-k">${ic('mic', 16)} Ваш вопрос</div>
          <form data-form="who-ask" class="wa-form"><input class="inp wa-inp" name="text" data-keep="who-ask" maxlength="120" placeholder="Я человек? Я из фильма?" autocomplete="off" required/><button class="btn primary mega">${ic('send', 20)} Спросить</button></form>
          ${q ? `<div class="wa-live"><span class="wa-q">«${esc(q.text)}»</span><span class="qa-t"><b class="y">Да ${q.yes}</b><b class="n">Нет ${q.no}</b><b>Не знаю ${q.idk}</b></span></div><p class="muted small center">Ответили все: «да» — спрашивайте дальше, «нет» — ход переходит</p>` : ''}
        </div>
        ${myQa.length ? `<div class="card qa-card"><div class="side-h">${ic('list', 16)} Ваши вопросы</div>${qaCards(myQa)}</div>` : ''}`;
    } else if (!over) {
      qBox = `<div class="card qa-card"><div class="qa-asker">${pa(asker, 32, 'round')}<span>Спрашивает <b>${nm(asker)}</b></span></div>
        ${
          q
            ? `<div class="qa-big">«${esc(q.text)}»</div>
               <div class="qa-note">${q.pend ? `<p class="qa-split">${ic('clock', 15)} ${q.pend.v === 'no' ? 'Ответ «нет» — ход перейдёт' : 'Засчитываем — следующий вопрос'} через 2 секунды. Можно передумать.</p>` : q.split ? `<p class="qa-split">${ic('alert', 15)} «Да» и «нет» поровну — договоритесь и переголосуйте</p>` : ''}</div>
               <div class="qa-btns">${['yes', 'no', 'idk'].map((v) => `<button class="btn qa-b qa-${v} ${q.mine === v ? 'on' : ''} ${q.pend && q.pend.v === v ? 'pending' : ''}" data-act="who-ans" data-v="${v}"><b>${AL[v]}</b>${rollCount('q' + q.id + v, q[v])}<span class="qa-who">${qVotes(v)}</span>${q.pend && q.pend.v === v ? `<span class="pend" style="--d:${q.pend.ms}ms;--e:-${Math.max(0, q.pend.ms - (q.pend.at - now()))}ms">${ring('fill')}</span>` : ''}</button>`).join('')}</div>`
            : `<div class="qa-big muted">Ждём вопрос…</div>`
        }
        ${g.players[asker]?.qa?.length ? `<details class="qa-hist"><summary>Что уже спросил ${nm(asker)} · ${g.players[asker].qa.length}</summary>${qaCards(g.players[asker].qa)}</details>` : ''}
      </div>`;
    }
    const actions = over
      ? ''
      : `<div class="mega-dock">
          ${g.turnPid === me ? `<button class="btn primary mega" data-act="who-next">${ic('skip', 24)} Передать ход</button>` : ''}
          ${!myState.guessed && !myState.gaveUp ? `<button class="btn success mega" data-act="who-guessed">${ic('check', 24)} Я угадал!</button><button class="btn ghost mega" data-act="who-giveup">${ic('flag', 22)} Сдаюсь</button>` : `<span class="muted">Вы уже ${myState.guessed ? 'угадали' : 'сдались'} — помогайте остальным</span>`}
        </div>`;
    // Справа — список «Не знаете, что спросить?» (только тому, кто сейчас спрашивает); уже заданные скрываем
    let sugg = '';
    if (!over && asker === me) {
      // Список подстраивается под ответы: очевидное убираем, уточняющие вопросы — сверху
      const { fresh, rest } = window.WhoSugg ? window.WhoSugg(myQa) : { fresh: [], rest: WHO_SUGG };
      const item = (t, isNew) => `<button type="button" class="ws-item ${isNew ? 'new' : ''}" data-act="who-sugg" data-t="${esc(t)}"><span>${esc(t)}</span>${ic('chevron', 14)}</button>`;
      if (fresh.length || rest.length)
        sugg = `<aside class="who-sugg" data-scroll="who-sugg">
          <div class="side-h">${ic('bulb', 16)} Не знаете, что спросить?</div>
          <p class="muted small">Нажмите — вопрос появится в поле. Список меняется по вашим ответам</p>
          ${fresh.length ? `<div class="ws-h">${ic('sparkles', 13)} Уточните</div><div class="ws-list">${fresh.map((t) => item(t, true)).join('')}</div>` : ''}
          ${rest.length ? `${fresh.length ? '<div class="ws-h">Ещё варианты</div>' : ''}<div class="ws-list">${rest.map((t) => item(t)).join('')}</div>` : ''}
        </aside>`;
    }
    return `<div class="who who2 ${sugg ? 'has-sugg' : ''} ${ui.enter ? 'enter' : ''}">
      <aside class="who-players" data-scroll="who-players">
        <div class="side-h">${ic('users', 16)} Игроки <span class="muted small">${g.q && g.q.asker === g.turnPid && !over ? `ответили ${Object.keys(g.q.who).length} из ${g.order.filter((id) => id !== g.turnPid && g.players[id]).length}` : g.finishOrder.length ? `угадали ${g.finishOrder.length} из ${g.order.length}` : ''}</span></div>
        <div class="who-list">${tiles}</div>
      </aside>
      <div class="who-main">
      <div class="banner">${over ? `${ic('sparkles', 18)} Все персонажи угаданы!` : `<span>${ic('mic', 16)} Спрашивает <b>${nm(g.turnPid)}</b> — минута, чтобы придумать вопрос. Большинство «нет» — ход переходит.</span>`}</div>
      ${over ? `<div class="card"><div class="side-h">Очки <span class="muted small">— угадал +1, первый +2, второй +1</span></div>${leaderboard(Object.entries(g.points))}</div>` : ''}
      ${qBox}
      <div class="card notes-card">${myQa.length && asker !== me ? `<div class="side-h">${ic('list', 16)} Мои вопросы и ответы</div>${qaCards(myQa)}` : ''}<div class="side-h">${ic('pencil', 16)} Мои заметки <span class="muted small">— видно только вам</span></div><textarea class="inp notes" data-keep="notes" data-notes="${notesKey}" rows="2" placeholder="Не человек, мужчина, из фильма…">${esc(LS.get(notesKey, ''))}</textarea></div>
      ${actions}
      </div>
      ${sugg}
    </div>`;
  }

  // Счётчик, который «прокручивается»: новое число въезжает снизу, старое уходит вверх
  const ROLL_MS = 420;
  function rollCount(key, n) {
    const st = (ui.roll = ui.roll || {});
    const cur = st[key];
    if (!cur) st[key] = { n, prev: n, at: 0 };
    else if (cur.n !== n) st[key] = { n, prev: cur.n, at: now() };
    const r = st[key];
    const el = now() - r.at;
    if (el >= ROLL_MS || r.prev === r.n) return `<span class="roll"><span class="roll-n">${n}</span></span>`;
    const up = r.n > r.prev ? '' : ' down';
    return `<span class="roll${up}"><span class="roll-o" style="animation-delay:-${el}ms">${r.prev}</span><span class="roll-n in" style="animation-delay:-${el}ms">${n}</span></span>`;
  }

  // ===== Намёк понял: всё по центру, главное действие — крупно =====
  function rJust(g) {
    const me = S.me;
    const T = ''; // таймер — общей полосой под шапкой
    // Шапка: раунд, цель, кто угадывает — тремя плитками
    const head = `<div class="jo-top">
      <div class="jo-tile"><span class="jt-k">Раунд</span><b class="jt-v">${g.round}</b></div>
      <div class="jo-tile"><span class="jt-k">До победы</span><b class="jt-v">${g.target}<small>${plural(g.target, 'очко', 'очка', 'очков')}</small></b></div>
      <div class="jo-tile wide ${g.isGuesser ? 'me' : ''}"><span class="jt-k">Угадывает</span><span class="jt-who">${pa(g.guesser, 40, 'round')}<b>${nm(g.guesser)}${g.isGuesser ? ' <small>(вы)</small>' : ''}</b></span></div>
    </div>`;
    // Таблица очков: сердечки рядом с очками
    const rows = Object.entries(g.points).sort((a, b) => b[1] - a[1] || (g.hearts[b[0]] || 0) - (g.hearts[a[0]] || 0));
    const board = `<div class="card jo-board"><div class="side-h">Очки <span class="muted small">— угадал +2 · подсказка дошла +1 · лучшая подсказка +3</span></div>
      ${rows.map(([id, n], i) => `<div class="jb-row ${id === g.guesser ? 'turn' : ''} ${id === me ? 'me' : ''}"><span class="jb-place">${i + 1}</span>${pa(id, 28, 'round')}<span class="jb-n">${nm(id)}</span>${g.hearts[id] ? `<span class="jb-h" title="Сколько раз его подсказку выбрали лучшей">${ic('heartf', 15)}${g.hearts[id]}</span>` : ''}<b class="jb-p" data-cnt="jb-${id}">${n}</b></div>`).join('')}</div>`;
    if (!g.inGame) return `<div class="narrow justone">${head}<div class="stage-card"><button class="btn primary mega" data-act="jo-add">Присоединиться</button></div>${board}</div>`;
    // Кто уже готов (видят все)
    const readyRow = (ids, done, label) =>
      `<div class="jo-ready"><span class="muted small">${label} ${done.length}/${ids.length}</span><span class="jr-list">${ids
        .map((id) => `<span class="jr ${done.includes(id) ? 'on' : ''}" title="${nm(id)}${done.includes(id) ? ' — готов' : ' — думает'}"><span class="ava-wrap">${pa(id, 34, 'round')}${done.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span><small>${nm(id)}</small></span>`)
        .join('')}</span></div>`;
    const hearted = (c) => (g.isGuesser ? g.heart != null && c.key === g.heart : c.pid === g.heart);
    const clueEl = (c, tag = 'div', extra = '') =>
      `<${tag} class="jc ${c.removed ? 'removed' : ''} ${hearted(c) ? 'hearted' : ''}" ${extra}><b class="${jcLen(c.text)}" lang="ru" style="--n:${Math.max(6, String(c.text || '').length)}">${esc(c.text)}</b>${c.first && !c.removed ? `<span class="jc-first" title="Написал эту подсказку первым — совпадения у остальных сгорели">${ic('medal', 13)} первым</span>` : ''}${hearted(c) ? `<span class="jc-heart">${ic('heartf', 20)}</span>` : ''}${c.pid && !g.isGuesser ? `<small>${pa(c.pid, 'xs', 'round')}${nm(c.pid)}</small>` : ''}${c.removed && c.by && !g.isGuesser ? `<span class="jc-by">${c.by === 'dup' ? (c.beat ? `${ic('swap', 12)} первым — ${pa(c.beat, 'xs', 'round')}<b>${nm(c.beat)}</b>` : `${ic('swap', 12)} совпала с другой`) : c.by === 'word' ? `${ic('alert', 12)} это само слово` : `${ic('x', 12)} вычеркнул ${pa(c.by, 'xs', 'round')}<b>${nm(c.by)}</b>`}</span>` : ''}</${tag}>`;
    // Длинные слова — мельче, чтобы не рвались посередине («Нижевол-осье»)
    function jcLen(t) {
      const n = String(t || '').length;
      return n > 15 ? 'l-xl' : n > 12 ? 'l-l' : n > 9 ? 'l-m' : '';
    }
    const bigForm = (form, ph, btnText, keep) =>
      `<form data-form="${form}" class="big-form"><input class="inp big-inp" name="text" data-keep="${keep}" maxlength="30" placeholder="${ph}" autocomplete="off" pattern="[A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9]+(-[A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9]+)*" title="Одно слово: буквы и цифры, можно через дефис" ${form === 'jo-clue' ? 'required' : ''}/><button class="btn primary mega">${btnText}</button></form>`;
    let body = '';
    if (g.phase === 'clues') {
      body = g.isGuesser
        ? `<div class="stage-card">${T}<div class="kicker">Вы угадываете</div><div class="big-ic">${ic('eyeoff', 48)}</div><h2 class="h2">Не подглядывайте — подсказчики пишут</h2>${readyRow(g.helpers, g.submitted, 'Написали')}</div>`
        : `<div class="stage-card">${T}<div class="kicker">Загаданное слово</div><div class="mega-word">${esc(g.word)}</div>
            ${g.myClue ? `<div class="jo-sent">${ic('check', 18)} Ваша подсказка: <b>${esc(g.myClue)}</b> <span class="muted">— ждём остальных</span></div>` : bigForm('jo-clue', 'Одно слово-подсказка', `${ic('send', 22)} Отправить`, 'jo-clue')}
            <p class="muted small">Одно слово: буквы и цифры, можно через дефис. Отправленную подсказку поменять нельзя.</p>
            ${readyRow(g.helpers, g.submitted, 'Написали')}</div>`;
    } else if (g.phase === 'filter') {
      const iShow = g.show.includes(me);
      body = g.isGuesser
        ? `<div class="stage-card">${T}<div class="big-ic">${ic('eyeoff', 48)}</div><h2 class="h2">Подсказчики убирают совпадения…</h2>${readyRow(g.helpers, g.show, 'Готовы показать')}</div>`
        : `<div class="stage-card">${T}<div class="kicker">Слово: ${esc(g.word)}</div><p>Вычеркните одинаковые и однокоренные подсказки — совпадения уже отмечены. Нажмите на подсказку, чтобы переключить.</p>
            <div class="jc-grid">${g.clues.map((c) => clueEl(c, 'button', `data-act="jo-toggle" data-pid="${c.pid}"`)).join('')}</div>
            <button class="btn ${iShow ? 'ja-on' : 'primary'} mega" data-act="jo-filterdone">${iShow ? `${ic('check', 22)} Вы готовы — отменить` : `Показать угадывающему ${ic('play', 22)}`}</button>
            ${readyRow(g.helpers, g.show, 'Нажали «Показать»')}</div>`;
    } else if (g.phase === 'guess') {
      const cl = g.clues.map((c) => clueEl(c)).join('');
      body = g.isGuesser
        ? `<div class="stage-card"><div class="kicker">Подсказки для вас</div><div class="jc-grid">${cl || `<p class="muted">${ic('alert', 16)} Все подсказки сгорели</p>`}</div>
            ${bigForm('jo-guess', 'Ваш ответ — одно слово', 'Ответить', 'jo-guess')}
            <button class="link-btn" data-act="jo-pass">пропустить слово</button></div>`
        : `<div class="stage-card"><div class="kicker">Слово: ${esc(g.word)}</div><div class="jc-grid">${cl}</div><p class="muted">${nm(g.guesser)} думает…</p></div>`;
    } else if (g.phase === 'result') {
      const voting = g.guess && !g.correct;
      const res = g.correct === null ? `${ic('skip', 22)} Пропуск — очков нет` : g.accepted ? `${ic('check', 22)} Засчитано — все подсказчики согласны` : g.correct ? `${ic('check', 22)} Угадано!` : `${ic('x', 22)} Не совпало`;
      const amHelper = g.helpers.includes(me);
      const voteRow = (list) => `<span class="ja-votes">${g.helpers.map((id) => `<span class="ava-wrap ${list.includes(id) ? 'is-ready' : ''}" title="${nm(id)}">${pa(id, 'sm', 'round')}${list.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span>`).join('')}<span class="muted small">${list.length}/${g.helpers.length}</span></span>`;
      const decide = voting
        ? `<div class="jo-accept">
            <p><b>Почти угадал?</b> <span class="muted">Синоним, опечатка или другая форма слова. Решение — когда так нажмут все подсказчики. Не договорились за время — не засчитано.</span></p>
            <div class="ja-two">
              <div class="ja-opt">${voteRow(g.accept)}${amHelper ? `<button class="btn ${g.accept.includes(me) ? 'ja-on' : 'success'} big-w" data-act="jo-override">${ic('check', 18)} Засчитать</button>` : ''}</div>
              <div class="ja-opt">${voteRow(g.reject)}${amHelper ? `<button class="btn ${g.reject.includes(me) ? 'ja-off' : 'danger'} big-w" data-act="jo-reject">${ic('x', 18)} Не засчитывать</button>` : ''}</div>
            </div>
            ${g.isGuesser ? '<p class="muted center">Подсказчики решают…</p>' : ''}
          </div>`
        : '';
      const live = g.clues.filter((c) => !c.removed);
      let hearts = '';
      if (g.correct) {
        hearts = g.isGuesser
          ? `<p><b>Какая подсказка помогла больше всего?</b> <span class="muted small">Авторы скрыты — выбирайте честно. Автору +3</span></p><div class="jc-grid">${live.map((c) => clueEl(c, 'button', `data-act="jo-heart" data-key="${c.key}"`)).join('')}</div>`
          : `<div class="jc-grid">${live.map((c) => clueEl(c)).join('')}</div>`;
      }
      const nextBtn = voting
        ? isHost() ? `<button class="btn ghost" data-act="jo-next">Хост: дальше без решения ${ic('play', 16)}</button>` : ''
        : g.correct && !g.isGuesser && !isHost()
          ? `<span class="muted">${g.heart == null ? `Ждём отметку от ${nm(g.guesser)}` : `${ic('heartf', 14)} Лучшая подсказка выбрана`}</span>`
          : `<button class="btn primary mega" data-act="jo-next">${g.isGuesser && g.correct && g.heart == null ? 'Дальше без отметки' : 'Дальше'} ${ic('play', 20)}</button>`;
      body = `<div class="stage-card">${T}<div class="kicker">Было слово</div><div class="mega-word">${esc(g.word)}</div>
        <p class="jo-ans">Ответ: <b>${esc(g.guess || '—')}</b></p><h2 class="h2 res">${res}</h2>
        ${decide}${hearts}
        <div class="row c">${nextBtn}</div></div>`;
    } else if (g.phase === 'over') {
      body = `<div class="stage-card"><div class="big-ic">${ic('bulb', 56)}</div><h2 class="h2">Победа: ${g.winners.map(nm).join(', ')}!</h2>
        ${canRestart() ? `<button class="btn primary big-w" data-act="jo-restart">${ic('reset', 18)} Ещё раз</button>` : ''}</div>`;
    }
    // Прошлые слова — карточками
    const hist = g.history.length
      ? `<div class="card jo-hist"><div class="side-h">${ic('list', 16)} Прошлые слова</div><div class="jh-grid">${g.history
          .slice()
          .reverse()
          .map((h) => {
            const st = h.correct ? 'ok' : h.correct === null ? 'skip' : 'no';
            const lbl = h.correct ? (h.accepted ? 'засчитано' : 'угадал') : h.correct === null ? 'пропуск' : 'мимо';
            return `<div class="jh ${st}">
              <div class="jh-top"><b class="jh-w">${esc(h.word)}</b><span class="jh-st">${ic(h.correct ? 'check' : h.correct === null ? 'skip' : 'x', 13)} ${lbl}</span></div>
              <div class="jh-g">${pa(h.guesser, 'xs', 'round')}<span>${nm(h.guesser)}</span>${h.guess ? `<span class="muted">→ «${esc(h.guess)}»</span>` : ''}</div>
              ${h.heart ? `<div class="jh-h">${ic('heartf', 13)} лучшая подсказка — ${nm(h.heart)}</div>` : ''}
            </div>`;
          })
          .join('')}</div></div>`
      : '';
    const glow = ['clues', 'filter'].includes(g.phase) ? '<div class="turn-glow g-top-y" aria-hidden="true"></div>' : g.phase === 'guess' ? '<div class="turn-glow g-top-b" aria-hidden="true"></div>' : '';
    return `${glow}<div class="narrow justone">${head}${body}${board}${hist}</div>`;
  }

  // ===== Викторина: ответ — число, шкала эффектно заполняется до правильного ответа =====
  const QZ_FILL = 2400; // длительность заполнения шкалы, мс
  const fmtN = (v, unit) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    const isYear = /год/.test(unit || '');
    const r = Math.round(n * 1000) / 1000;
    return isYear || Math.abs(r) < 10000 ? String(r).replace('.', ',') : r.toLocaleString('ru-RU').replace(/ /g, ' ');
  };
  function qzRange(res) {
    const vals = [res.answer, ...res.list.map((x) => x.v)];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = hi - lo ? (hi - lo) * 0.12 : Math.max(1, Math.abs(res.answer) * 0.15);
    lo -= pad;
    hi += pad;
    if (Math.min(...vals) >= 0 && lo < 0) lo = 0;
    if (hi - lo > 20) {
      lo = Math.floor(lo);
      hi = Math.ceil(hi);
    }
    return [lo, hi];
  }
  // Кнопка «Дальше» + кто уже нажал; после того как готовы все — 5 секунд отсчёта до следующего вопроса
  function nextBar(g, act) {
    // Таймер результата идёт параллельно: смотрим итоги и жмём «Дальше»; нажали все — следующий вопрос сразу
    const total = g.phaseMs || 10000;
    const left = g.endsAt ? Math.max(0, g.endsAt - now()) : 0;
    const ring = g.endsAt ? `<div class="nx-ring" title="До следующего вопроса" style="--nx:-${total - left}ms;--nd:${total}ms"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19"/></svg><b data-nx="${g.endsAt}">${Math.max(1, Math.ceil(left / 1000))}</b></div>` : '';
    const iReady = g.ready.includes(S.me);
    return `<div class="nx-wrap">
      <div class="nx-row">${ring}<button class="btn ${iReady ? 'ja-on' : 'primary'} big-w" data-act="${act}">${iReady ? `${ic('check', 18)} Готов — ждём остальных` : `Дальше ${ic('play', 18)}`}</button></div>
      <div class="jo-ready nx-who"><span class="muted small">Нажали «Дальше» ${g.ready.length}/${g.order.length}</span><span class="jr-list">${g.order.map((id) => `<span class="jr ${g.ready.includes(id) ? 'on' : ''}"><span class="ava-wrap">${pa(id, 34, 'round')}${g.ready.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span><small>${nm(id)}</small></span>`).join('')}</span></div>
    </div>`;
  }

  function rQuiz(g) {
    const me = S.me;
    const T = ''; // таймер — общей полосой под шапкой
    const rows = Object.entries(g.points).sort((a, b) => b[1] - a[1]);
    const board = `<div class="card jo-board"><div class="side-h">Очки <span class="muted small">— ближе всех +1 · точно в цель ещё +1</span></div>
      ${rows.map(([id, n], i) => `<div class="jb-row ${id === me ? 'me' : ''}"><span class="jb-place">${i + 1}</span>${pa(id, 28, 'round')}<span class="jb-n">${nm(id)}</span>${g.wins[id] ? `<span class="qz-w" title="Сколько раз был ближе всех">${ic('target', 14)}${g.wins[id]}</span>` : ''}<b class="jb-p" data-cnt="jb-${id}">${n}</b></div>`).join('')}</div>`;
    const head = `<div class="jo-top qz-head">
      <div class="jo-tile"><span class="jt-k">Вопрос</span><b class="jt-v">${g.round}<small>из ${g.rounds}</small></b></div>
      <div class="jo-tile wide"><span class="jt-k">Тема</span><b class="jt-v qz-cat">${esc(g.q?.cat || '')}</b></div>
    </div>`;
    if (!g.inGame) return `<div class="narrow quiz">${head}<div class="stage-card"><button class="btn primary mega" data-act="qz-add">Присоединиться</button></div>${board}</div>`;
    let body = '';
    if (g.phase === 'answer') {
      const ready = `<div class="jo-ready"><span class="muted small">Ответили ${g.answered.length}/${g.order.length}</span><span class="jr-list">${g.order.map((id) => `<span class="jr ${g.answered.includes(id) ? 'on' : ''}"><span class="ava-wrap">${pa(id, 34, 'round')}${g.answered.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span><small>${nm(id)}</small></span>`).join('')}</span></div>`;
      body = `<div class="stage-card qz-card">${T}
        <div class="qz-q">${esc(g.q.text)}</div>
        <form data-form="qz-answer" class="big-form qz-form"><input class="inp big-inp qz-inp" name="v" data-keep="qz-v" inputmode="decimal" autocomplete="off" placeholder="${esc(g.q.mask || 'Ваше число')}" aria-label="Ваше число, ${g.q.mask ? g.q.mask.replace(/[^X]/g, '').length + ' цифр' : ''}" required/>${g.q.unit ? `<span class="qz-unit">${esc(g.q.unit)}</span>` : ''}<button class="btn primary mega">${g.mine != null ? 'Изменить' : 'Ответить'}</button></form>
        ${g.mine != null ? `<div class="jo-sent">${ic('check', 18)} Ваш ответ: <b>${fmtN(g.mine, g.q.unit)}</b> <span class="muted">— можно изменить, пока идёт время</span></div>` : `<p class="muted small">${g.q.mask ? `Подсказка: в ответе <b class="qz-mask">${esc(g.q.mask)}</b> — столько цифр. ` : ''}Можно с запятой: 3,14.</p>`}
        ${ready}</div>`;
    } else if (g.phase === 'reveal' && g.res) {
      const r = g.res;
      const [lo, hi] = qzRange(r);
      const pct = (v) => ((v - lo) / (hi - lo)) * 100;
      const start = (ui.qzStart = ui.qzStart || {})[g.round] || (ui.qzStart[g.round] = now());
      const el = Math.max(0, now() - start);
      // Раскладываем метки по «дорожкам» сверху и снизу, чтобы близкие ответы не налезали друг на друга
      const LANES = ['up', 'dn', 'up2', 'dn2', 'up3', 'dn3'];
      const lastX = {};
      const placed = r.list
        .slice()
        .sort((a, b) => a.v - b.v)
        .map((x) => {
          const px = pct(x.v);
          const lane = LANES.find((l) => lastX[l] == null || px - lastX[l] > 9) || LANES[0];
          lastX[lane] = px;
          return { ...x, px, lane };
        });
      const order = r.list.map((x) => x.pid);
      const markers = placed
        .map((x) => {
          const win = r.winners.includes(x.pid);
          const i = order.indexOf(x.pid);
          return `<div class="qz-m ${win ? 'win' : ''} ${x.lane}" style="left:${x.px}%;animation-delay:${QZ_FILL + 150 + i * 140 - el}ms"><span class="qz-mv">${fmtN(x.v, g.q.unit)}</span>${pa(x.pid, 30, 'round')}</div>`;
        })
        .join('');
      const deep = placed.some((x) => /3$/.test(x.lane)) ? 3 : placed.some((x) => /2$/.test(x.lane)) ? 2 : 1;
      const list = r.list
        .map((x) => {
          const pts = r.got[x.pid] || 0;
          return `<div class="qz-r ${r.winners.includes(x.pid) ? 'win' : ''}">${pa(x.pid, 28, 'round')}<span class="jb-n">${nm(x.pid)}</span><span class="qz-rv">${fmtN(x.v, g.q.unit)}</span><span class="qz-rd">${x.diff < 1e-9 ? 'в яблочко!' : `±${fmtN(x.diff, '')}`}</span><b class="qz-rp">${pts ? '+' + pts : ''}</b></div>`;
        })
        .join('');
      const iReady = g.ready.includes(me);
      body = `<div class="stage-card qz-card">${T}
        <div class="qz-q sm">${esc(g.q.text)}</div>
        <div class="qz-reveal" data-qz-round="${g.round}" data-qz-from="${lo}" data-qz-to="${r.answer}" data-qz-unit="${esc(g.q.unit || '')}" data-qz-start="${start}">
          <div class="qz-big"><span class="qz-num">${el >= QZ_FILL ? fmtN(r.answer, g.q.unit) : fmtN(lo, g.q.unit)}</span><span class="qz-u">${esc(g.q.unit || '')}</span></div>
          <div class="qz-bar lanes-${deep}">
            <div class="qz-fill" style="--p:${pct(r.answer)}%;animation-delay:-${el}ms"></div>
            <div class="qz-hit" style="left:${pct(r.answer)}%;animation-delay:${QZ_FILL - el}ms"></div>
            ${markers}
          </div>
          <div class="qz-scale"><span>${fmtN(lo, g.q.unit)}</span><span>${fmtN(hi, g.q.unit)}</span></div>
        </div>
        ${r.list.length ? `<div class="qz-list" style="animation-delay:${QZ_FILL + 300 - el}ms">${list}</div>` : '<p class="muted">Никто не успел ответить</p>'}
        ${nextBar(g, 'qz-ready')}
      </div>`;
    } else if (g.phase === 'over') {
      body = `<div class="stage-card"><div class="big-ic">${ic('trophy', 56)}</div><h2 class="h2">Победа: ${(g.winners || []).map(nm).join(', ')}!</h2>
        ${canRestart() ? `<button class="btn primary big-w" data-act="qz-restart">${ic('reset', 18)} Ещё раз</button>` : ''}</div>`;
    }
    return `<div class="narrow quiz">${g.phase !== 'over' ? head : ''}${body}${board}</div>`;
  }
  // ---------- Ответ большинства ----------
  function rMajority(g) {
    const me = S.me;
    const rows = Object.entries(g.points).sort((a, b) => b[1] - a[1]);
    const board = `<div class="card jo-board"><div class="side-h">Очки <span class="muted small">— +1 за каждое совпадение · большинству ещё +1</span></div>
      ${rows.map(([id, n], i) => `<div class="jb-row ${id === me ? 'me' : ''}"><span class="jb-place">${i + 1}</span>${pa(id, 28, 'round')}<span class="jb-n">${nm(id)}</span><b class="jb-p" data-cnt="jb-${id}">${n}</b></div>`).join('')}</div>`;
    const head = `<div class="jo-top qz-head">
      <div class="jo-tile"><span class="jt-k">Вопрос</span><b class="jt-v">${g.round}<small>из ${g.rounds}</small></b></div>
      <div class="jo-tile wide"><span class="jt-k">Задача</span><b class="jt-v mj-task">${g.phase === 'review' ? 'Кто с кем совпал?' : 'Ответь, как ответит большинство'}</b></div>
    </div>`;
    if (!g.inGame) return `<div class="narrow quiz">${head}<div class="stage-card"><button class="btn primary mega" data-act="mj-add">Присоединиться</button></div>${board}</div>`;
    let body = '';
    if (g.phase === 'answer') {
      const ready = `<div class="jo-ready"><span class="muted small">Ответили ${g.answered.length}/${g.order.length}</span><span class="jr-list">${g.order.map((id) => `<span class="jr ${g.answered.includes(id) ? 'on' : ''}"><span class="ava-wrap">${pa(id, 34, 'round')}${g.answered.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span><small>${nm(id)}</small></span>`).join('')}</span></div>`;
      body = `<div class="stage-card qz-card">
        <div class="qz-q">${esc(g.q)}</div>
        <form data-form="mj-answer" class="big-form qz-form mj-form"><input class="inp big-inp" name="text" data-keep="mj-t" maxlength="40" autocomplete="off" placeholder="Ваш ответ" required/><button class="btn primary mega">${g.mine != null ? 'Изменить' : 'Ответить'}</button></form>
        ${g.mine != null ? `<div class="jo-sent">${ic('check', 18)} Ваш ответ: <b>${esc(g.mine)}</b> <span class="muted">— никто его не видит до конца раунда</span></div>` : '<p class="muted small">Одно-два слова. Пишите то, что напишут остальные.</p>'}
        ${ready}</div>`;
    } else if (g.phase === 'review') {
      const host = isHost();
      const sel = ui.mjSel && g.groups.some((x) => x.pids.includes(ui.mjSel)) ? ui.mjSel : null;
      const t0 = (ui.mjStart = ui.mjStart || {})[g.round] || (ui.mjStart[g.round] = now());
      const el = now() - t0;
      const lock = false;
      const canEdit = host && !lock;
      const max = Math.max(1, ...g.groups.map((x) => x.pids.length));
      const total = g.groups.reduce((n, x) => n + x.pids.length, 0);
      // Итог для меня — сразу понятно, что произошло
      const myG = g.groups.find((x) => x.pids.includes(me));
      const myPts = g.preview[me] || 0;
      const mates = myG ? myG.pids.length - 1 : 0;
      const mine = !myG
        ? `<div class="mj-me none">${ic('clock', 20)}<div><b>Вы не успели ответить</b><span>0 очков в этом раунде</span></div></div>`
        : `<div class="mj-me ${myG.major ? 'major' : mates ? 'ok' : 'solo'}">
            <span class="mj-me-ic">${myG.major ? ic('crown', 22) : mates ? ic('users', 22) : ic('x', 22)}</span>
            <div><b>${myG.major ? 'Вы в большинстве!' : mates ? `Совпали с ${mates} ${plural(mates, 'игроком', 'игроками', 'игроками')}` : 'Никто не ответил так же'}</b><span>Ваш ответ «${esc(g.mine || myG.texts[0])}»</span></div>
            <b class="mj-me-pts">${myPts ? '+' + myPts : '0'}</b>
          </div>`;
      const row = (x, i) => {
        const on = sel && x.pids.includes(sel);
        const pts = g.preview[x.pids[0]] || 0;
        const solo = x.pids.length === 1;
        const target = canEdit && sel && !on;
        return `<div class="mj-row ${x.major ? 'major' : ''} ${solo ? 'solo' : ''} ${on ? 'sel' : ''} ${target ? 'target' : ''} ${x.pids.includes(me) ? 'mine' : ''} ${canEdit ? 'host' : ''}" ${canEdit ? `data-act="mj-pick" data-id="${x.pids[0]}" role="button" tabindex="0"` : ''} style="--w:${(x.pids.length / max) * 100}%;--d:${i * 110 - el}ms">
          <i class="mj-bar"></i>
          <span class="mj-rk">${x.major ? ic('crown', 18) : solo ? '' : i + 1}</span>
          <div class="mj-main">
            <div class="mj-ans">${x.texts.map(esc).join(' <i>·</i> ')}</div>
            <div class="mj-avs">${x.pids.map((p) => `<span class="mj-p">${pa(p, 24, 'round')}<small>${nm(p)}</small>${canEdit && !solo ? `<button class="mj-x" data-act="mj-split" data-id="${p}" title="Отделить этот ответ">${ic('x', 11)}</button>` : ''}</span>`).join('')}</div>
          </div>
          <div class="mj-side"><b class="mj-cnt">${x.pids.length}</b><span class="mj-pts ${pts ? '' : 'zero'}">${pts ? `+${pts} каждому` : '0 очков'}</span></div>
          ${target ? `<span class="mj-merge">${ic('link', 14)} Склеить сюда</span>` : ''}
        </div>`;
      };
      const tip = lock
        ? ''
        : host
          ? sel
            ? `<div class="mj-tip on">${ic('link', 16)} Выберите ответ, с которым склеить. Нажмите на тот же — отмена</div>`
            : `<div class="mj-tip">${ic('sparkles', 15)} Похожие ответы разошлись? Нажмите на один, потом на другой — они склеятся</div>`
          : `<div class="mj-tip">${ic('sparkles', 15)} Похожие ответы хост может склеить вручную</div>`;
      body = `<div class="stage-card qz-card mj-review">
        <div class="qz-q sm">${esc(g.q)}</div>
        ${mine}
        <div class="mj-sum"><span>${g.groups.length} ${plural(g.groups.length, 'разный ответ', 'разных ответа', 'разных ответов')} от ${total} ${plural(total, 'игрока', 'игроков', 'игроков')}</span>${g.groups.some((x) => x.major) ? `<span class="mj-sum-m">${ic('crown', 13)} большинство +1</span>` : '<span class="muted">большинства нет — ничья по размеру</span>'}</div>
        <div class="mj-rows">${g.groups.map(row).join('')}</div>
        ${tip}
        ${nextBar(g, 'mj-ready')}
      </div>`;
    } else if (g.phase === 'over') {
      body = `<div class="stage-card"><div class="big-ic">${ic('trophy', 56)}</div><h2 class="h2">Победа: ${(g.winners || []).map(nm).join(', ')}!</h2>
        ${canRestart() ? `<button class="btn primary big-w" data-act="mj-restart">${ic('reset', 18)} Ещё раз</button>` : ''}</div>`;
    }
    return `<div class="narrow quiz majority">${g.phase !== 'over' ? head : ''}${body}${board}</div>`;
  }

  // ---------- Расписной покер ----------
  const SUIT_SYM = { s: '♠', c: '♣', d: '♦', h: '♥' };
  const SUIT_NAME = { s: 'пики', c: 'трефы', d: 'бубны', h: 'червы' };
  const RANK_L = { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
  const pcSuit = (c) => c.slice(-1);
  const pcRank = (c) => Number(c.slice(0, -1));
  // Карта: null — рубашка
  function pcard(c, g, opts = {}) {
    const cls = `pc ${opts.cls || ''}`;
    if (!c) return `<span class="${cls} back"></span>`;
    if (c === g.joker) return `<${opts.btn ? 'button' : 'span'} class="${cls} joker" ${opts.btn || ''}><b>🃏</b><small>джокер</small></${opts.btn ? 'button' : 'span'}>`;
    const su = pcSuit(c), r = pcRank(c);
    const red = su === 'h' || su === 'd';
    const lbl = RANK_L[r] || r;
    return `<${opts.btn ? 'button' : 'span'} class="${cls} ${red ? 'red' : ''} ${su === g.trump ? 'trump' : ''}" ${opts.btn || ''}><i class="tl">${lbl}<em>${SUIT_SYM[su]}</em></i><b>${SUIT_SYM[su]}</b><i class="br">${lbl}<em>${SUIT_SYM[su]}</em></i></${opts.btn ? 'button' : 'span'}>`;
  }
  function rPoker(g) {
    const me = S.me;
    const myTurn = g.turnPid === me;
    const trumpTxt = g.trump ? `${SUIT_SYM[g.trump]} ${SUIT_NAME[g.trump]}` : 'без козыря';
    // Места за столом: заказ / взято, кто ходит, кто сдаёт
    const seats = g.order
      .map((id) => {
        const bid = g.bids[id];
        const took = g.took[id] || 0;
        const st = g.noBid ? `взял ${took}` : bid == null ? (g.phase === 'bid' ? 'думает…' : '—') : `${bid === 0 ? 'пас' : 'заказ ' + bid} · взял ${took}`;
        const good = !g.noBid && bid != null && took === bid;
        const over = !g.noBid && bid != null && took > bid;
        return `<div class="pk-seat ${id === g.turnPid ? 'on' : ''} ${id === me ? 'me' : ''} ${good ? 'good' : ''} ${over ? 'over' : ''}">
          ${pa(id, 40, 'round')}${id === g.dealer ? '<span class="pk-dealer" title="Сдаёт">С</span>' : ''}
          <div class="pk-sb"><b>${nm(id)}</b><small>${st}</small></div>
          <span class="pk-cnt" title="Карт на руках">${g.counts[id]}</span>
          <b class="pk-tot" data-cnt="pk-${id}">${g.total[id]}</b>
        </div>`;
      })
      .join('');
    // Стол: текущая взятка (или только что собранная)
    const showTrick = g.phase === 'trick' && g.lastTrick ? g.lastTrick.cards : g.trick;
    const win = g.phase === 'trick' && g.lastTrick ? g.lastTrick.winner : null;
    const jName = (j) => (j === 'low' ? 'младшая' : j === 'high' ? 'забирает' : j?.startsWith('high-') ? `старшие ${SUIT_SYM[j.slice(5)]}` : '');
    const trick = showTrick.length
      ? showTrick.map((x, i) => `<div class="pk-play ${x.pid === win ? 'win' : ''}" style="--i:${i}">${pcard(x.c, g)}${x.j ? `<em class="pk-j">${jName(x.j)}</em>` : ''}<span>${pa(x.pid, 22, 'round')}${nm(x.pid)}</span></div>`).join('')
      : `<p class="pk-hint">${g.phase === 'bid' ? (myTurn ? 'Ваш заказ' : `Заказывает ${nm(g.turnPid)}`) : g.phase === 'play' ? (myTurn ? 'Ваш ход — выберите карту' : `Ходит ${nm(g.turnPid)}`) : ''}</p>`;
    // Заказ взяток
    let bidBox = '';
    if (g.phase === 'bid' && myTurn) {
      bidBox = `<div class="pk-bid"><span class="muted small">Сколько возьмёте взяток?${g.forbidden != null ? ` Сдающему нельзя ${g.forbidden} — сумма не должна равняться ${g.k}` : ''}</span><div class="pk-bid-b">${Array.from({ length: g.k + 1 }, (_, n) => `<button class="btn ${n === 0 ? 'ghost' : ''}" data-act="pk-bid" data-n="${n}" ${n === g.forbidden ? 'disabled' : ''}>${n === 0 ? 'Пас' : n}</button>`).join('')}</div></div>`;
    }
    // Рука
    const canPlay = g.phase === 'play' && myTurn;
    const hand = g.hand
      .map((c) => {
        const ok = canPlay && c && g.playable.includes(c);
        return pcard(c, g, { cls: `${ok ? 'ok' : canPlay ? 'no' : ''} ${ui.pkJ === c ? 'sel' : ''}`, btn: c ? `data-act="pk-play" data-c="${c}" ${canPlay && !ok ? 'aria-disabled="true"' : ''}` : '' });
      })
      .join('');
    // Как сыграть джокер
    let jBox = '';
    if (ui.pkJ && canPlay) {
      const lead = !g.trick.length;
      const opts = lead ? [...(g.trump ? [['high-' + g.trump, `Забрать: по старшим козырям ${SUIT_SYM[g.trump]}`]] : []), ...['s', 'c', 'd', 'h'].filter((x) => x !== g.trump).map((x) => ['high-' + x, `Забрать: по старшим ${SUIT_SYM[x]} ${SUIT_NAME[x]}`]), ['low', 'Скинуть как самую младшую']] : [['high', 'Забрать взятку'], ['low', 'Скинуть (младшая карта)']];
      jBox = `<div class="pk-jbox"><b>🃏 Как сыграть джокер?</b>${opts.map(([v, t]) => `<button class="btn ${v === 'low' ? 'ghost' : 'primary'}" data-act="pk-joker" data-j="${v}">${t}</button>`).join('')}<button class="btn ghost" data-act="pk-joker-x">Отмена</button></div>`;
    }
    // Итоги сдачи
    let result = '';
    if (g.phase === 'dealEnd' && g.dealResult) {
      result = `<div class="pk-res"><div class="side-h">Итоги сдачи${g.spName ? ` · ${g.spName}` : ` · по ${g.k}`}</div>${g.order
        .map((id) => {
          const r = g.dealResult.rows[id];
          if (!r) return '';
          return `<div class="pk-rr">${pa(id, 26, 'round')}<b>${nm(id)}</b><span class="muted small">${r.bid == null ? '' : r.bid === 0 ? 'пас' : `заказ ${r.bid}`} · взял ${r.took}</span><em class="${r.pts > 0 ? 'up' : r.pts < 0 ? 'down' : ''}">${r.pts > 0 ? '+' : ''}${r.pts}</em><b class="pk-rt">${r.total}</b></div>`;
        })
        .join('')}${isHost() ? `<button class="btn primary" data-act="pk-next">Следующая сдача ${ic('play', 16)}</button>` : '<p class="muted small center">Следующая сдача через пару секунд</p>'}</div>`;
    }
    const over = g.phase === 'over'
      ? `<div class="pk-res"><div class="big-ic">${ic('trophy', 48)}</div><h2 class="h2 center">Победа: ${(g.winner || []).map(nm).join(', ')}!</h2>${canRestart() ? `<button class="btn primary big-w" data-act="pk-restart">${ic('reset', 18)} Ещё партию</button>` : ''}</div>`
      : '';
    return `<div class="poker ${ui.enter ? 'enter' : ''}">
      <div class="pk-top">
        <div class="pk-info"><span class="pk-chip">Сдача <b>${g.deal}</b> из ${g.deals}</span><span class="pk-chip">${g.spName ? `<b class="pk-sp">${g.spName}</b>` : `по <b>${g.k}</b> ${plural(g.k, 'карте', 'карты', 'карт')}`}</span><span class="pk-chip">Сдаёт ${nm(g.dealer)}</span></div>
        <div class="pk-trump"><span class="muted small">Козырь</span>${g.trumpCard ? pcard(g.trumpCard, g, { cls: 'mini' }) : ''}<b>${trumpTxt}</b></div>
        <button class="btn sm ghost" data-act="pk-sheet">${ic('list', 15)} Таблица</button>
      </div>
      <div class="pk-seats">${seats}</div>
      <div class="pk-table ${g.phase === 'trick' ? 'done' : ''}">${over || result || `<div class="pk-trick">${trick}</div>`}</div>
      ${bidBox}${jBox}
      ${g.inGame ? `<div class="pk-hand ${canPlay ? 'turn' : ''} ${g.dark && g.phase === 'bid' ? 'dark' : ''}">${g.dark && g.phase === 'bid' ? '<span class="pk-dark">Тёмная: заказ — не глядя в карты</span>' : ''}${hand}</div>` : ''}
      ${ui.pkSheet ? pokerSheet(g) : ''}
    </div>`;
  }
  // Таблица записи, как на бумаге: строки — сдачи, у каждого игрока заказ и очки (накопительно)
  function pokerSheet(g) {
    const rows = g.plan
      .map((lbl, i) => {
        const r = g.sheet[i];
        const nowRow = i === g.deal - 1 && g.phase !== 'over';
        return `<tr class="${nowRow ? 'cur' : ''} ${/[BMTZ]/.test(lbl) ? 'spx' : ''}"><th>${{ B: 'Б', M: 'М', T: 'Т', Z: 'З' }[lbl] || lbl}</th>${g.order
          .map((id) => {
            const x = r?.rows[id];
            const bid = x ? (x.bid == null ? '' : x.bid === 0 ? '–' : x.bid) : nowRow && g.bids[id] != null ? (g.bids[id] === 0 ? '–' : g.bids[id]) : '';
            return `<td class="b">${bid}</td><td class="${x && x.pts < 0 ? 'neg' : ''}">${x ? x.total : ''}</td>`;
          })
          .join('')}</tr>`;
      })
      .join('');
    return `<div class="modal-bg" data-act="pk-sheet"></div><div class="modal card pk-sheet" role="dialog" aria-label="Таблица">
      <div class="side-h">${ic('list', 16)} Таблица записи <button class="icon-x" data-act="pk-sheet" style="margin-left:auto">${ic('x', 16)}</button></div>
      <div class="pk-sheet-w"><table><thead><tr><th rowspan="2">Сдача</th>${g.order.map((id) => `<th colspan="2">${nm(id)}</th>`).join('')}</tr><tr>${g.order.map(() => '<th class="b">заказ</th><th>очки</th>').join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">Б — бескозырка, М — мизер, Т — тёмная, З — золотая. «–» — пас.</p>
    </div>`;
  }

  // ---------- Кости 1000 ----------
  // Подсчёт очков для подсказки при выборе (сервер считает так же и всё проверяет)
  function diceScore(vals) {
    if (!vals.length) return null;
    const sorted = vals.slice().sort((a, b) => a - b).join('');
    if (vals.length === 5 && sorted === '12345') return 125;
    if (vals.length === 5 && sorted === '23456') return 250;
    const cnt = [0, 0, 0, 0, 0, 0, 0];
    for (const v of vals) cnt[v]++;
    let pts = 0;
    for (let f = 1; f <= 6; f++) {
      let n = cnt[f];
      if (n >= 3) {
        pts += n === 3 ? (f === 1 ? 100 : f * 10) : n === 4 ? (f === 1 ? 200 : f * 20) : f === 1 ? 1000 : f * 100;
        n = 0;
      }
      if (n) {
        if (f === 1) pts += 10 * n;
        else if (f === 5) pts += 5 * n;
        else return null;
      }
    }
    return pts;
  }
  const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  // Поворот кубика, при котором грань v смотрит на нас (противоположные грани в сумме 7)
  const FACE_ROT = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
  const faceHtml = (v) => `<span class="face f${v}">${Array.from({ length: 9 }, (_, k) => `<i class="${PIPS[v].includes(k + 1) ? 'on' : ''}"></i>`).join('')}</span>`;
  const CUBE = [1, 2, 3, 4, 5, 6].map(faceHtml).join('');
  const hash = (n) => {
    let x = (n * 2654435761) >>> 0;
    x ^= x >>> 15;
    return x / 4294967295;
  };
  function die3(d, i, g, opts = {}) {
    const [fx, fy] = FACE_ROT[d.v];
    const r1 = hash(g.rollId * 13 + i), r2 = hash(g.rollId * 29 + i * 7);
    const sx = fx - 720 - Math.floor(r1 * 4) * 90;
    const sy = fy + 720 + Math.floor(r2 * 4) * 90;
    const el = now() - (g.rollAt || 0);
    const rolling = d.fresh && g.rollAt && el < g.rollMs + 400;
    const style = `--fx:${fx}deg;--fy:${fy}deg;--sx:${sx}deg;--sy:${sy}deg;--de:${-el + i * 70}ms;--tilt:${((r1 - 0.5) * 16).toFixed(1)}deg`;
    const cls = `die3 ${rolling ? 'rolling' : ''} ${opts.sel ? 'sel' : ''} ${opts.can ? 'can' : ''} ${opts.dim ? 'dim' : ''} ${opts.small ? 'small' : ''}`;
    return opts.act ? `<button class="${cls}" data-act="dc-pick" data-i="${i}" style="${style}" aria-label="Кубик ${d.v}${opts.sel ? ', выбран' : ''}"><span class="cube">${CUBE}</span></button>` : `<span class="${cls}" style="${style}"><span class="cube">${CUBE}</span></span>`;
  }
  function rDice(g) {
    const me = S.me;
    const myTurn = g.turnPid === me && g.phase !== 'over';
    // Выбор костей: на каждый новый бросок по умолчанию выбраны все зачётные
    if (!ui.dsel || ui.dsel.rollId !== g.rollId) ui.dsel = { rollId: g.rollId, set: new Set(g.best || []) };
    const sel = [...ui.dsel.set].filter((i) => g.dice[i] && !g.dice[i].kept);
    const selPts = g.phase === 'pick' ? diceScore(sel.map((i) => g.dice[i].v)) : null;
    const free = g.dice.map((d, i) => ({ d, i })).filter((x) => !x.d.kept);
    const kept = g.dice.map((d, i) => ({ d, i })).filter((x) => x.d.kept);
    const rollingNow = g.rollAt && now() - g.rollAt < g.rollMs;
    if (rollingNow && ui.dRend !== g.rollId) {
      ui.dRend = g.rollId; // после анимации — перерисовать, чтобы включить кнопки
      setTimeout(render, g.rollMs - (now() - g.rollAt) + 80);
    }
    const total = g.total[g.turnPid] || 0;
    const entered = g.entered[g.turnPid];
    const sum = g.turnPts + (selPts || 0);
    // Можно ли записать и почему нет
    const allKept = g.phase === 'pick' && free.every((x) => sel.includes(x.i));
    let stopWhy = '';
    if (g.phase === 'pick') {
      if (selPts == null) stopWhy = sel.length ? 'выбраны незачётные кости' : 'выберите зачётные кости';
      else if (allKept) stopWhy = 'все 5 зачётные — нужен подтверждающий бросок';
      else if (!entered && sum < g.entry) stopWhy = `допуск — нужно ${g.entry}+`;
      else if (total === g.barrel && sum < g.target - g.barrel) stopWhy = `на бочке нужно ${g.target - g.barrel}+`;
    }
    const after = !stopWhy && g.phase === 'pick' ? (total === g.barrel ? g.target : Math.min(g.barrel, total + sum)) : null;
    // Игроки слева: счёт, прогресс до 1000, допуск и бочка
    const players = g.order
      .map((id) => {
        const t = g.total[id] || 0;
        const on = id === g.turnPid && g.phase !== 'over';
        const tag = g.winner === id ? `<b class="dp-tag win">${ic('trophy', 12)} победа</b>` : t === g.barrel ? '<b class="dp-tag barrel">🛢 на бочке</b>' : !g.entered[id] ? '<b class="dp-tag no">нет допуска</b>' : '';
        return `<div class="dp ${on ? 'on' : ''} ${id === me ? 'me' : ''}">
          ${pa(id, 44, 'round')}
          <div class="dp-b"><span class="dp-n">${nm(id)}${id === me ? ' <small>(вы)</small>' : ''}</span>${tag}
            <i class="dp-bar"><i style="width:${(t / g.target) * 100}%"></i><i class="mk m-entry" style="left:${(g.entry / g.target) * 100}%"></i><i class="mk m-barrel" style="left:${(g.barrel / g.target) * 100}%"></i></i></div>
          <b class="dp-t" data-cnt="dc-${id}">${t}</b>
        </div>`;
      })
      .join('');
    const logRow = (l) =>
      l.kind === 'bust'
        ? `<div class="dl bust">${pa(l.pid, 20, 'round')}<span>${nm(l.pid)} — пусто${l.pts ? `, сгорело ${l.pts}` : ''}</span></div>`
        : l.kind === 'drop'
          ? `<div class="dl drop">${pa(l.pid, 20, 'round')}<span>${nm(l.pid)} слетел с бочки на ${l.to} — его сбросил ${nm(l.by)}</span></div>`
          : `<div class="dl rec">${pa(l.pid, 20, 'round')}<span>${nm(l.pid)} записал <b>+${l.pts}</b> → ${l.total}${l.note ? ` · ${l.note}` : ''}</span></div>`;
    let actions = '';
    if (g.phase === 'over') {
      actions = `<div class="dc-over">${ic('trophy', 26)} <b>${nm(g.winner)}</b> набрал 1000 и победил!</div>${canRestart() ? `<button class="btn primary big-w" data-act="dc-restart">${ic('reset', 18)} Сыграть ещё</button>` : ''}`;
    } else if (!myTurn) {
      actions = `<p class="muted center">${g.phase === 'bust' ? '' : `Бросает ${nm(g.turnPid)}…`}</p>`;
    } else if (g.phase === 'start') {
      actions = `<button class="btn primary mega dc-roll" data-act="dc-roll">${ic('dice5', 26)} Бросить</button>`;
    } else if (g.phase === 'pick') {
      const nRoll = allKept ? 5 : free.length - sel.length;
      actions = `<div class="dc-btns">
        <button class="btn primary mega dc-roll" data-act="dc-roll" ${selPts == null || rollingNow ? 'disabled' : ''}>${ic('dice5', 24)} ${allKept ? 'Подтверждающий бросок · 5' : `Бросить ещё · ${nRoll}`}</button>
        <button class="btn success mega" data-act="dc-stop" ${stopWhy || rollingNow ? 'disabled' : ''}>${ic('check', 22)} Записать${after != null ? ` → ${after}` : ''}</button>
      </div>
      <p class="dc-why ${stopWhy ? '' : 'ok'}">${stopWhy ? `Записать нельзя: ${stopWhy}` : 'Можно записать или рискнуть и бросить ещё'}</p>`;
    }
    const status = g.phase === 'bust'
      ? `<div class="dc-bust">${ic('x', 20)} Пусто! ${g.bust?.lost ? `Сгорело ${g.bust.lost} очков` : 'Ни одной зачётной кости'} — ход переходит</div>`
      : '';
    return `<div class="dice-g ${ui.enter ? 'enter' : ''}">
      <aside class="dice-side" data-scroll="dice-side">
        <div class="side-h">${ic('users', 16)} Игроки <span class="muted small">допуск ${g.entry} · бочка ${g.barrel} · до ${g.target}</span></div>
        <div class="dp-list">${players}</div>
        ${g.log.length ? `<div class="side-h dl-h">${ic('list', 15)} Ходы</div><div class="dl-list">${g.log.map(logRow).join('')}</div>` : ''}
      </aside>
      <section class="dice-main">
        <div class="dc-head">
          <div class="dc-who">${pa(g.turnPid, 40, 'round')}<div><span class="muted small">${g.phase === 'over' ? 'Игра окончена' : myTurn ? 'Ваш ход' : 'Ходит'}</span><b>${nm(g.turnPid)}</b></div></div>
          <div class="dc-pts"><span class="muted small">За ход</span><b data-cnt="dc-turn">${g.phase === 'bust' ? 0 : g.turnPts}</b>${selPts ? `<em>+${selPts}</em>` : ''}</div>
          <div class="dc-pts"><span class="muted small">На счёте</span><b>${total}</b></div>
        </div>
        <div class="dc-table ${g.phase === 'bust' && !rollingNow ? 'busted' : ''}">
          <div class="dc-row">${free.length ? free.map(({ d, i }) => die3(d, i, g, { act: myTurn && g.phase === 'pick', sel: g.phase === 'pick' && ui.dsel.set.has(i), can: (g.best || []).includes(i), dim: g.phase === 'start' })).join('') : ''}</div>
          ${kept.length ? `<div class="dc-kept"><span class="muted small">Отложено</span>${kept.map(({ d, i }) => die3({ ...d, fresh: false }, i, g, { small: true })).join('')}</div>` : ''}
          ${status}
        </div>
        ${g.phase === 'pick' && myTurn ? '<p class="muted small center">Нажмите на кубик, чтобы взять или вернуть. Подсвечены зачётные</p>' : ''}
        <div class="dc-actions">${actions}</div>
      </section>
    </div>`;
  }

  // ---------- Коднеймс: капитанский вид «по цветам» ----------
  // Порядок: свои → соперников → нейтральные → убийца; внутри группы открытые — в конце
  function cnRank(c, i, myTeam) {
    const other = myTeam === 'red' ? 'blue' : 'red';
    const g = c.color === myTeam ? 0 : c.color === other ? 1 : c.color === 'neutral' ? 2 : 3;
    return g * 100 + (c.revealed ? 50 : 0) + i;
  }
  // Переключение с анимацией FLIP: запоминаем, где были карточки, ставим новый порядок,
  // и плавно «доезжаем» из старых мест в новые
  function cnSortSet(on) {
    on = !!on;
    if (!!ui.cnSort === on) return;
    const g = S?.game;
    const board = $app.querySelector('.cn-board');
    const btn = $app.querySelector('[data-cn-sort]');
    if (!g || g.type !== 'codenames' || !board || !btn) return;
    const myTeam = g.team[S.me];
    const cards = [...board.querySelectorAll('.cn-card[data-i]')];
    const first = cards.map((el) => el.getBoundingClientRect());
    ui.cnSort = on;
    cards.forEach((el) => (el.style.order = on ? String(cnRank(g.cards[Number(el.dataset.i)], Number(el.dataset.i), myTeam)) : ''));
    board.classList.toggle('sorted', on);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cards.forEach((el, k) => {
      const a = first[k];
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, zIndex: 3 },
          { transform: `translate(${dx * 0.1}px, ${dy * 0.1}px) scale(1.04)`, zIndex: 3, offset: 0.75 },
          { transform: 'none', zIndex: 3 },
        ],
        { duration: 460, easing: 'cubic-bezier(.2, .85, .25, 1)', delay: (Number(el.dataset.i) % 5) * 12 + Math.floor(Number(el.dataset.i) / 5) * 10 }
      );
    });
  }
  // Мышь: вид держится, пока курсор на кнопке. Палец: касание включает/выключает.
  document.addEventListener('mouseover', (e) => {
    const onBtn = e.target.closest && e.target.closest('[data-cn-sort]');
    if (onBtn) cnSortSet(true);
    else if (ui.cnSort && !ui.cnSortPin) cnSortSet(false);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-cn-sort]');
    if (!b) return;
    if (matchMedia('(hover: hover)').matches) return;
    ui.cnSortPin = !ui.cnSort;
    cnSortSet(!ui.cnSort);
  });

  // Бегущее число на шкале: каждый кадр — по текущему элементу (переживает перерисовки)
  let qzRaf = 0;
  function qzLoop() {
    cancelAnimationFrame(qzRaf);
    const step = () => {
      const box = $app.querySelector('.qz-reveal');
      if (!box) return;
      const t = Math.min(1, (now() - Number(box.dataset.qzStart)) / QZ_FILL);
      const e = 1 - Math.pow(1 - t, 3);
      const from = Number(box.dataset.qzFrom);
      const to = Number(box.dataset.qzTo);
      const num = box.querySelector('.qz-num');
      const dec = (String(to).split('.')[1] || '').length; // столько знаков, сколько в правильном ответе
      const k = Math.pow(10, dec);
      if (num) num.textContent = fmtN(t >= 1 ? to : Math.round((from + (to - from) * e) * k) / k, box.dataset.qzUnit);
      if (t < 1) qzRaf = requestAnimationFrame(step);
      else if (!box.dataset.done) {
        box.dataset.done = '1';
        if (ui.qzDone !== box.dataset.qzRound) {
          ui.qzDone = box.dataset.qzRound;
          Sound.play('win');
        }
      }
    };
    qzRaf = requestAnimationFrame(step);
  }

  // Сердечки падают сверху — тому, чью подсказку выбрали лучшей
  function heartRain() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.createElement('div');
    box.className = 'heart-rain';
    let html = '';
    for (let i = 0; i < 34; i++) {
      const size = 16 + Math.random() * 26;
      html += `<span style="left:${Math.random() * 100}vw;animation-delay:${Math.random() * 1.4}s;animation-duration:${2.2 + Math.random() * 1.6}s;--dx:${(Math.random() - 0.5) * 120}px">${ic('heartf', Math.round(size))}</span>`;
    }
    box.innerHTML = html;
    document.body.appendChild(box);
    Sound.play('win');
    setTimeout(() => box.remove(), 4400);
  }

  // ---------- обработчики ----------
  const ACTIONS = {
    'ask-yes': () => askDone(true),
    'ask-no': () => askDone(false),
    // фото и профиль
    'photo-pick': () => fileInp.click(),
    'photo-del': () => setPhoto(null).then(render),
    'crop-cancel': () => {
      ui.crop = null;
      render();
    },
    'crop-save': async () => {
      if (!ui.crop) return;
      const data = cropExport();
      ui.crop = null;
      await setPhoto(data);
      render();
    },
    'me-open': () => {
      ui.menu = null;
      ui.meEdit = ui.meAnim = true;
      render();
      ui.meAnim = false;
    },
    'me-close': () => {
      ui.meEdit = false;
      render();
    },
    // меню, тема, чат, музыка
    menu: (d) => {
      ui.menu = ui.menu === d.menu ? null : d.menu;
      ui.popAnim = !!ui.menu;
      if (ui.menu) Sound.play('open');
      render();
    },
    'sfx-mute': () => {
      if (Sound.vol) {
        ui.sfxPrev = Sound.vol;
        Sound.setVol(0);
      } else Sound.setVol(ui.sfxPrev || 60);
      render();
      Sound.play('tap');
    },
    'set-theme': (d) => {
      document.documentElement.setAttribute('data-theme', d.t);
      LS.set('pg_theme', d.t);
      document.querySelectorAll('.tt').forEach((el) => {
        el.dataset.t = d.t;
        el.querySelectorAll('.tt-hit').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === d.t)));
      });
      syncWave();
    },
    'view-tog': (d) => {
      const k = d.k;
      if (!VIEW_TOGGLES.includes(k)) return;
      VIEW[k] = !VIEW[k];
      LS.set('pg_' + k, VIEW[k] ? '1' : '');
      applyView();
      syncWave();
      render();
    },
    'view-glow': (d) => {
      VIEW.glow = Number(d.n) || 0;
      LS.set('pg_glow_v', String(VIEW.glow));
      applyView();
      render();
    },
    'glow-ok': () => {
      ui.glowAsk = false;
      LS.set('pg_glow_asked', '1');
      render();
    },
    'view-fs': (d) => {
      VIEW.fs = Number(d.n);
      LS.set('pg_cnfs', String(VIEW.fs));
      applyView();
      render();
    },
    'grant-open': (d) => {
      ui.grantFor = ui.grantFor === d.pid ? null : d.pid;
      render();
    },
    grant: async (d) => {
      const r = await emit('grantCoins', { target: d.pid, amount: Number(d.n) });
      if (!r.error) {
        toast(`+${d.n} монет — ${player(d.pid)?.name || 'игроку'}`, 'coinup');
        Sound.play('coin');
      }
    },
    'gift-open': () => {
      ui.menu = ui.menu === 'gift' ? null : 'gift';
      ui.gs = { step: 'list' };
      ui.popAnim = !!ui.menu;
      if (ui.menu) Sound.play('open');
      render();
    },
    'gift-pick': (d) => {
      const g = GIFTS[d.id];
      if (!g) return;
      if (g.price > (S.coins || 0)) {
        Sound.play('error');
        return toast(`Не хватает монет: ${g.name} стоит ${g.price}, у вас ${S.coins || 0}. Монеты дают за время в игре — 300 каждые 10 минут`);
      }
      ui.gs = { step: 'to', id: d.id };
      render();
    },
    'gift-to': (d) => {
      ui.gs = { ...ui.gs, step: 'ok', to: d.pid };
      render();
    },
    'gift-back': () => {
      const st = ui.gs || {};
      ui.gs = st.step === 'ok' ? { step: 'to', id: st.id } : { step: 'list' };
      render();
    },
    'gift-send': async () => {
      const st = ui.gs;
      if (!st || st.busy || !st.id || !st.to) return; // защита от двойного нажатия
      st.busy = true;
      st.nonce = st.nonce || Math.random().toString(36).slice(2) + Date.now().toString(36);
      render();
      const r = await emit('gift', { gift: st.id, to: st.to, nonce: st.nonce });
      if (r.error) {
        st.busy = false;
        return render();
      }
      ui.menu = null;
      ui.gs = null;
      render();
    },
    lofi: () => {
      if (!music.on) return startMusic();
      music.open = !music.open;
      syncMusicUI();
    },
    resume: () => emit('resumeGame'),
    // коднеймс
    'cn-join': (d) => act('join', { team: d.team, captain: false }),
    'cn-cap': (d) => act('join', { team: d.team, captain: true }),
    'cn-mark': (d) => act('mark', { i: Number(d.i) }),
    'cn-end': () => act('endTurn'),
    'cn-end-force': () => act('endTurn', { force: true }),
    'cn-new': async () => (await ask({ title: 'Разложить новую доску?', text: 'Текущая партия закончится, карточки будут новые.', ok: 'Новая доска', icon: 'grid' })) && act('newBoard'),
    'cn-shuffle': async () => (await ask({ title: 'Перемешать команды?', text: 'Игроки разойдутся по командам случайно, капитаны тоже назначатся случайно.', ok: 'Перемешать', icon: 'shuffle' })) && act('shuffleTeams'),
    'cn-pause': () => act('pauseClock'),
    'cn-ready': async () => {
      const was = S.game.ready[S.me];
      const r = await act('ready');
      if (!r.error) Sound.play(was ? 'unready' : 'ready');
    },
    'cn-force': () => act('forceStart'),
    'cn-reset': () => act('resetClock'),
    'cn-sadd': () => {
      if (!ui.cnSlots || ui.cnSlots.length >= 9) return;
      ui.cnSlots.push({ id: slotId(), v: '1' });
      render();
    },
    'cn-sdel': (d) => {
      ui.cnSlots = ui.cnSlots.filter((x) => x.id !== d.id);
      if (ui.cnSlots[0]) ui.cnSlots[0].j = false;
      render();
    },
    'cn-link': (d) => {
      const x = (ui.cnSlots || []).find((y) => y.id === d.id);
      if (x) x.j = !x.j;
      Sound.play(x?.j ? 'pop' : 'tap');
      render();
    },
    'cn-strike': (d) => act('strike', { clue: Number(d.clue), k: Number(d.k) }),
    'cn-edit': () => {
      const c = S.game.clue;
      ui.cnEdit = true;
      ui.cnSlots = c.slots.map((x) => ({ id: slotId(), v: fmtV(x.v), j: !!x.j }));
      render();
      $app.querySelector('.clue-word')?.focus();
    },
    'cn-edit-cancel': () => {
      ui.cnEdit = false;
      ui.cnSlots = null;
      render();
    },
    // элиас
    'al-join': (d) => act('join', { team: Number(d.team) }),
    'al-shuffle': () => act('shuffleTeams'),
    'al-begin': () => act('begin'),
    'al-go': () => act('go'),
    'al-got': () => act('got'),
    'al-skip': () => act('skip'),
    'al-toggle': (d) => act('toggle', { i: Number(d.i) }),
    'al-confirm': () => act('confirm'),
    'al-confirm-force': () => act('confirm', { force: true }),
    'al-skipturn': () => act('skipTurn'),
    'al-restart': async () => (await ask({ title: 'Начать заново?', text: 'Счёт всех команд обнулится.', ok: 'Начать заново', danger: true, icon: 'reset' })) && act('restart'),
    // шпион
    'spy-hide': () => {
      ui.hideCard = !ui.hideCard;
      render();
    },
    'spy-vote': (d) => act('vote', { target: d.pid }),
    'spy-claim': async () => (await ask({ title: 'Назвать локацию?', text: 'Скажите локацию вслух — мирные решат, угадали вы или нет.', ok: 'Называю', icon: 'spy' })) && act('claim'),
    'spy-judge': (d) => act('judge', { ok: d.ok === '1' }),
    'spy-reveal': () => act('reveal'),
    'spy-next': () => act('next'),
    // кто я
    'who-random': () => act('randomFor'),
    'who-sugg': (d) => {
      const inp = $app.querySelector('input[data-keep="who-ask"]');
      if (!inp) return;
      inp.value = d.t;
      inp.focus();
      inp.select();
    },
    'who-img': () => whoFile.click(),
    'who-img-x': () => {
      ui.whoImg = null;
      render();
    },
    'who-force': () => act('forceStart'),
    'who-next': () => act('next'),
    'who-ans': (d) => act('answer', { v: d.v }),
    'cn-sum': () => {
      ui.showSum = !ui.showSum;
      ui.sumAnim = ui.showSum;
      render();
    },
    'spy-ask': (d) => act('askWho', { target: d.pid }),
    'spy-answered': () => act('answered'),
    'who-guessed': async () => (await ask({ title: 'Вы угадали?', text: 'Вы назвали персонажа вслух, и остальные подтвердили?', ok: 'Да, угадал', icon: 'check' })) && act('guessed'),
    'who-giveup': async () => (await ask({ title: 'Сдаться?', text: 'Персонаж откроется, очков за него не будет.', ok: 'Сдаться', danger: true, icon: 'flag' })) && act('giveUp'),
    'who-add': () => act('addMe'),
    // намёк понял
    'jo-toggle': (d) => act('toggle', { pid: d.pid }),
    'jo-filterdone': () => act('filterDone'),
    'jo-pass': () => act('guess', { text: '' }),
    'jo-override': () => act('override'),
    'qz-ready': () => act('ready'),
    'qz-restart': () => act('restart'),
    'qz-add': () => act('addMe'),
    'mj-add': () => act('addMe'),
    'mj-ready': () => act('ready'),
    'mj-restart': () => act('restart'),
    'dc-restart': () => act('restart'),
    'pk-restart': () => act('restart'),
    'pk-redeal': () => act('redeal'),
    'pk-next': () => act('next'),
    'pk-bid': (d) => act('bid', { n: Number(d.n) }),
    'pk-sheet': () => {
      ui.pkSheet = !ui.pkSheet;
      render();
    },
    'pk-play': (d) => {
      const g = S.game;
      if (!g || g.turnPid !== S.me || g.phase !== 'play') return;
      if (!g.playable.includes(d.c)) {
        Sound.play('error');
        return toast(g.trick.length ? 'Этой картой ходить нельзя: нужно в масть, а если её нет — козырем' : 'Этой картой сейчас нельзя');
      }
      if (d.c === g.joker) {
        ui.pkJ = d.c;
        return render();
      }
      act('play', { c: d.c });
    },
    'pk-joker': (d) => {
      const c = ui.pkJ;
      ui.pkJ = null;
      act('play', { c, j: d.j });
    },
    'pk-joker-x': () => {
      ui.pkJ = null;
      render();
    },
    'dc-skip': () => act('skipTurn'),
    'dc-pick': (d) => {
      const i = Number(d.i);
      if (!ui.dsel) return;
      if (ui.dsel.set.has(i)) ui.dsel.set.delete(i);
      else ui.dsel.set.add(i);
      Sound.play('tap');
      render();
    },
    'dc-roll': () => act('roll', { keep: ui.dsel ? [...ui.dsel.set] : [] }),
    'dc-stop': () => act('stop', { keep: ui.dsel ? [...ui.dsel.set] : [] }),
    'mj-skip': () => act('skip'),
    'mj-pick': (d) => {
      // хост склеивает группы: первый клик — выбрать, второй — куда добавить
      if (!ui.mjSel) ui.mjSel = d.id;
      else {
        const g = S.game;
        const ga = g.groups.find((x) => x.pids.includes(ui.mjSel));
        const gb = g.groups.find((x) => x.pids.includes(d.id));
        if (ga && gb && ga !== gb) act('merge', { a: ui.mjSel, b: d.id });
        ui.mjSel = null;
      }
      render();
    },
    'mj-split': (d) => {
      ui.mjSel = null;
      act('split', { a: d.id });
    },
    'qz-skip': () => act('skip'),
    'wait-begin': () => act('begin'),
    'al-last': (d) => act('lastTo', { to: d.to === 'none' ? 'none' : Number(d.to) }),
    'jo-reject': () => act('reject'),
    'jo-heart': (d) => act('heart', { key: Number(d.key) }),
    'jo-next': () => act('next'),
    'jo-force': () => act('forceFilter'),
    'jo-restart': () => act('restart'),
    'jo-add': () => act('addMe'),
    // марафон
    'tour-next': () => emit('tourNext'),
    'tour-end': () => emit('tourEnd'),
    'h-addtime': () => act('addTime'),
    'h-clearvotes': () => act('clearVotes'),
    'h-pauseturn': () => act('pauseTurn'),
    'h-pauseround': () => act('pauseRound'),
    'h-newword': () => act('newWord'),
    'h-skipq': () => act('skipQ'),
    'h-skipround': () => act('skipRound'),
    'h-newq': () => act('newQuestion'),
    'ctl-toggle': () => {
      ui.ctlOpen = !ui.ctlOpen;
      ui.ctlAnim = ui.ctlOpen;
      // сворачивание: кнопки уезжают вниз в шестерёнку
      if (!ui.ctlOpen) {
        ui.ctlClosing = true;
        setTimeout(() => {
          ui.ctlClosing = false;
          render();
        }, 230);
      }
      LS.set('pg_ctl', ui.ctlOpen ? '1' : '');
      render();
    },
    'tour-table': () => {
      ui.showTable = !ui.showTable;
      ui.tabAnim = ui.showTable;
      render();
    },
    mode: (d) => {
      if (d.m !== ui.mode) ui.modeAnim = d.m;
      ui.mode = d.m;
      render();
    },
    'm-rounds': (d) => {
      ui.mRounds[d.id] = Math.min(10, Math.max(1, (ui.mRounds[d.id] || 1) + Number(d.d)));
      render();
    },
    'm-preset': (d) => {
      const pr = PRESETS.find((x) => x.id === d.id);
      if (pr) applyPreset(pr);
      render();
    },
    'm-move': (d) => {
      const i = ui.mOrder.indexOf(d.id);
      const j = i + Number(d.d);
      if (j < 0 || j >= ui.mOrder.length) return;
      [ui.mOrder[i], ui.mOrder[j]] = [ui.mOrder[j], ui.mOrder[i]];
      render();
    },
  };

  document.addEventListener('click', async (e) => {
    // клик мимо открытого меню — закрыть его
    let closed = false;
    if (ui.menu && !e.target.closest('[data-pop]')) {
      ui.menu = null;
      closed = true;
    }
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled || !$app.contains(b)) {
      if (closed) render();
      return;
    }
    const a = b.dataset.act;
    const d = b.dataset;
    if (!['menu', 'cn-mark', 'cn-ready', 'sfx-mute'].includes(a)) Sound.play('click');
    if (a === 'cn-mark') Sound.play('tap');
    if (ACTIONS[a]) return ACTIONS[a](d);
    switch (a) {
      case 'copy': {
        const link = roomLink(S.room.code);
        try {
          await navigator.clipboard.writeText(link);
          toast('Ссылка скопирована', 'ok');
        } catch {
          ask({ title: 'Скопируйте ссылку', text: 'Браузер не дал скопировать автоматически — выделите и скопируйте вручную.', value: link, ok: 'Готово', noCancel: true, icon: 'link' });
        }
        break;
      }
      case 'rules':
        ui.showRules = ui.showRules ? false : d.g || (S.game ? S.game.type : ui.selected || S.room?.gameType || 'codenames');
        ui.rulesAnim = ui.rulesTabScroll = !!ui.showRules;
        render();
        break;
      case 'rules-tab':
        ui.showRules = d.g;
        ui.rulesTabScroll = true;
        render();
        break;
      case 'dd-open':
        ui.menu = ui.menu === 'dd:' + d.key ? null : 'dd:' + d.key;
        ui.popAnim = !!ui.menu;
        render();
        break;
      case 'dd-pick':
        ui.settings[d.key] = d.v;
        ui.menu = null;
        render();
        break;
      case 'stop':
        if (await ask({ title: 'Уйти в лобби?', text: 'Игра встанет на паузу — к ней можно будет вернуться.', ok: 'В лобби', icon: 'home' })) emit('stopGame');
        break;
      case 'pick':
        ui.selected = d.id;
        emit('selectGame', { type: d.id });
        render();
        break;
      case 'kick':
        ui.menu = null;
        if (await ask({ title: `Выгнать ${player(d.pid)?.name || 'игрока'}?`, text: 'Игрок пропадёт из комнаты и из текущей катки. Вернуться он сможет по ссылке.', ok: 'Выгнать', danger: true, icon: 'x' })) emit('kick', { target: d.pid });
        break;
      case 'makeHost':
        ui.menu = null;
        if (await ask({ title: `Сделать хостом ${player(d.pid)?.name || 'игрока'}?`, text: 'Он будет запускать игры и управлять комнатой, а вы станете обычным игроком.', ok: 'Передать', icon: 'crown' })) emit('makeHost', { target: d.pid });
        break;
      case 'leave':
        // Подтверждение — своим окном поверх всего
        ui.leaveAsk = true;
        ui.leaveAnim = true;
        render();
        break;
      case 'leave-no':
        ui.leaveAsk = false;
        render();
        break;
      case 'leave-yes':
        ui.leaveAsk = false;
        await emit('leaveRoom');
        S = null;
        syncRadio();
        history.replaceState(null, '', '/');
        render();
        break;
    }
  });

  function collectSettings(fd, meta, prefix = '') {
    const settings = {};
    for (const s of meta.settings || []) {
      const key = prefix + s.key;
      settings[s.key] = s.type === 'checkbox' ? fd.get(key) === 'on' : fd.get(key);
    }
    return settings;
  }

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    const fd = new FormData(f);
    const kind = f.dataset.form;
    const clear = () => f.querySelectorAll('[data-keep]').forEach((el) => (el.value = ''));
    if (kind === 'enter') {
      const name = String(fd.get('name') || '').trim();
      if (!name) return toast('Введите никнейм');
      LS.set('pg_name', name);
      LS.set('pg_real', String(fd.get('real') || '').trim());
      const go = e.submitter?.value || 'create';
      // После входа — солидная загрузка на 10 секунд (только при логине, не при переподключении)
      Loader.show('login');
      setTimeout(() => Loader.done('login'), 10000);
      if (go === 'join') {
        const code = (codeFromUrl() && !fd.get('code') ? codeFromUrl() : String(fd.get('code') || '')).toUpperCase();
        if (code.length !== 4) return toast('Код комнаты — 4 буквы');
        Loader.show('enter');
        const r = await emit('joinRoom', { token, code, ...(await enterPayload()) });
        if (r.error) Loader.done('enter');
      } else {
        Loader.show('enter');
        const r = await emit('createRoom', { token, ...(await enterPayload()) });
        if (r.error) Loader.done('enter');
      }
    } else if (kind === 'me') {
      const name = String(fd.get('name') || '').trim();
      const real = String(fd.get('real') || '').trim();
      if (!name) return toast('Введите никнейм');
      const r = await emit('rename', { name, real });
      if (!r.error) {
        LS.set('pg_name', name);
        LS.set('pg_real', real);
        ui.meEdit = false;
        render();
      }
    } else if (kind === 'start') {
      if (S.room.suspended && !(await ask({ title: 'Начать новую игру?', text: 'Игра на паузе будет удалена.', ok: 'Начать', danger: true, icon: 'play' }))) return;
      Loader.show('game');
      const r = await emit('startGame', { settings: collectSettings(fd, gameMeta(ui.selected)) });
      if (r.error) Loader.done('game');
      if (!r.error) f.querySelectorAll('textarea').forEach((t) => (t.value = ''));
    } else if (kind === 'tour') {
      if (S.room.suspended && !(await ask({ title: 'Начать марафон?', text: 'Игра на паузе будет удалена.', ok: 'Начать', danger: true, icon: 'trophy' }))) return;
      const plan = ui.mOrder.filter((id) => ui.mOn[id]).map((id) => ({ type: id, rounds: ui.mRounds[id] || 1, settings: collectSettings(fd, gameMeta(id), id + '__') }));
      Loader.show('game');
      const r = await emit('startTour', { plan });
      if (r.error) Loader.done('game');
      if (!r.error) ui.showTable = false;
    } else if (kind === 'clue') {
      const list = ui.cnSlots || [{ v: '1' }];
      const bad = list.find((x) => !validStrength(x.v));
      if (bad) return toast(`Сила «${bad.v || 'пусто'}» — число от −1 до 1 (кроме 0), до двух знаков: 1, 0.73, −0.5`);
      const edit = f.dataset.mode === 'edit';
      const r = await act(edit ? 'editClue' : 'clue', { word: fd.get('word'), slots: list.map((x, k) => ({ v: String(numV(x.v)), j: k > 0 && !!x.j })) });
      if (!r.error) {
        clear();
        ui.cnSlots = null;
        ui.cnEdit = false;
        render();
      }
    } else if (kind === 'who-write') {
      if (ui.whoImg && !ui.whoImg.url) return toast('Подождите — картинка ещё загружается');
      const r = await act('write', { text: fd.get('text'), img: ui.whoImg?.url || null });
      if (!r.error) {
        clear();
        ui.whoImg = null;
      }
    } else if (kind === 'who-ask') {
      const r = await act('ask', { text: fd.get('text') });
      if (!r.error) clear();
    } else if (kind === 'mj-answer') {
      const r = await act('answer', { text: fd.get('text') });
      if (!r.error) clear();
    } else if (kind === 'qz-answer') {
      const r = await act('answer', { v: fd.get('v') });
      if (!r.error) clear();
    } else if (kind === 'jo-clue') {
      const r = await act('clue', { text: fd.get('text') });
      if (!r.error) clear();
    } else if (kind === 'jo-guess') {
      const r = await act('guess', { text: fd.get('text') });
      if (!r.error) clear();
    }
  });

  // Сохраняем выбор настроек хоста между перерисовками
  document.addEventListener('change', (e) => {
    if (e.target.dataset.mon) {
      ui.mOn[e.target.dataset.mon] = e.target.checked;
      return render();
    }
    const f = e.target.closest('[data-form="start"], [data-form="tour"]');
    if (f && e.target.name) ui.settings[e.target.name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  });
  document.addEventListener(
    'toggle',
    (e) => {
      if (e.target.dataset?.mopen) ui.mOpen[e.target.dataset.mopen] = e.target.open;
    },
    true
  );
  // «Викторина»: вопрос нельзя выделить, скопировать или вырезать (кроме своего поля ввода)
  const quizLock = (e) => {
    if (S?.game?.type !== 'quiz') return;
    if (e.target.closest?.('input, textarea')) return;
    e.preventDefault();
    if (e.type === 'copy') toast('В «Викторине» копировать текст нельзя', 'info');
  };
  ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach((ev) => document.addEventListener(ev, quizLock));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.ask) return askDone(false);
    if (e.key === 'Escape' && (ui.menu || ui.crop || ui.meEdit || ui.showRules || ui.showSum || ui.showTable || ui.leaveAsk)) {
      ui.leaveAsk = false;
      ui.showSum = false;
      ui.showTable = false;
      ui.menu = null;
      if (ui.crop) ui.crop = null;
      else ui.meEdit = false;
      ui.showRules = false;
      render();
    }
  });
  let sfxT;
  document.addEventListener('input', (e) => {
    if (e.target.dataset.sfx !== undefined && e.target.matches('[data-sfx]')) {
      Sound.setVol(Number(e.target.value));
      const v = $app.querySelector('.sfx-v');
      if (v) v.textContent = Sound.vol;
      clearTimeout(sfxT);
      sfxT = setTimeout(() => Sound.play('pop'), 120);
    }
    // Силы слов: ползунок и поле синхронизируются без перерисовки (иначе обрывается перетаскивание)
    if (e.target.dataset.slot) {
      const x = (ui.cnSlots || []).find((y) => y.id === e.target.dataset.slot);
      if (x) {
        if (e.target.dataset.kind === 'range' && Number(e.target.value) === 0) e.target.value = numV(x.v) < 0 ? '-0.01' : '0.01'; // 0 — не сила
        x.v = e.target.dataset.kind === 'range' ? fmtV(e.target.value) : e.target.value;
        const twin = $app.querySelector(`[data-slot="${x.id}"][data-kind="${e.target.dataset.kind === 'range' ? 'num' : 'range'}"]`);
        if (twin && e.target.dataset.kind === 'range') twin.value = x.v;
        if (twin && e.target.dataset.kind === 'num' && validStrength(x.v)) twin.value = numV(x.v);
        e.target.closest('.slot')?.classList.toggle('bad', !validStrength(x.v));
        e.target.closest('.slot')?.classList.toggle('neg', validStrength(x.v) && numV(x.v) < 0);
      }
    }
    if (e.target.dataset.slot || e.target.dataset.preview) {
      const pv = document.getElementById('cn-preview');
      if (pv) pv.innerHTML = cluePreview();
    }
    if (e.target.dataset.notes) LS.set(e.target.dataset.notes, e.target.value);
  });

  render();
})();
