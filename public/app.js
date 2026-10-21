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
  const loadAvatar = () => {
    try {
      const a = JSON.parse(LS.get('pg_avatar', 'null'));
      return PixelAvatar.valid(a) ? a : null;
    } catch {
      return null;
    }
  };

  const socket = io({ transports: ['websocket', 'polling'] });
  let S = null; // последнее состояние от сервера
  let GAMES = [];
  let PROFILES = [];
  let offset = 0; // serverNow - clientNow
  let connected = false;
  const ui = {
    homeStep: 'who', // who | avatar
    homeSel: LS.get('pg_profile', '') || (LS.get('pg_name', '') ? 'new' : null),
    avatar: loadAvatar() || PixelAvatar.random(),
    avEdit: null, // черновик аватара в модалке (в комнате)
    selected: null,
    settings: {},
    showRules: false,
    chatOpen: false,
    chatSeen: 0,
    menu: null, // открытое всплывающее меню: 'theme' | 'p:<pid>'
    hideCard: false,
    cnSlots: null, // [{id, v}] — силы слов в подсказке капитана
    cnEdit: false, // капитан исправляет подсказку
    mode: 'single',
    mOrder: ['codenames', 'justone', 'whoami', 'spyfall', 'alias'],
    mOn: { codenames: true, justone: true, whoami: true, spyfall: true },
    mRounds: { codenames: 2, justone: 1, whoami: 1, spyfall: 3, alias: 1 },
    mOpen: {},
    showTable: false,
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
  const themeIcon = () => THEMES.find((t) => t.id === theme())?.icon || 'moon';
  const themeMenu = () => `<div class="menu-wrap" data-pop>
      <button class="btn sm ghost icon-btn" data-act="menu" data-menu="theme" title="Тема оформления">${ic(themeIcon())}</button>
      ${
        ui.menu === 'theme'
          ? `<div class="pop right ${ui.popAnim ? 'anim' : ''}">${THEMES.map((t) => `<button class="pop-i ${theme() === t.id ? 'on' : ''}" data-act="set-theme" data-t="${t.id}">${ic(t.icon, 16)}<span>${t.name}</span>${theme() === t.id ? ic('check', 16, 'tick') : ''}</button>`).join('')}</div>`
          : ''
      }
    </div>`;

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
    if (id && g?.type === 'codenames') return TEAM_BG[g.team[id]] || PixelAvatar.NEUTRAL;
    if (id && g?.type === 'alias') {
      const i = g.teams.findIndex((t) => t.members.includes(id));
      if (i >= 0) return ALIAS_BG[i];
    }
    return PixelAvatar.BG[hue(id || 'x') % PixelAvatar.BG.length];
  }
  function avaHtml(p, size = 'sm', cls = '') {
    const px = SIZES[size] || size;
    if (p?.avatar && PixelAvatar.valid(p.avatar))
      return `<span class="ava px ${size} ${cls}" style="width:${px}px;height:${px}px">${PixelAvatar.svg(p.avatar, px, p.bg || bgFor(p.id))}</span>`;
    const name = p?.name || '?';
    return `<span class="ava ${size} ${cls}" style="--h:${hue(name)};width:${px}px;height:${px}px"><b>${esc(initials(name))}</b></span>`;
  }
  const pa = (pid, size = 'sm', cls = '') => avaHtml(player(pid) || { name: '?' }, size, cls);
  const who = (pid, size = 'xs') => `<span class="who-n">${pa(pid, size)}<span>${nm(pid)}</span></span>`;

  function toast(msg, kind = 'err') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
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

  // ---------- лофи-радио (YouTube) ----------
  // У каждого игрока своё: играет только у того, кто включил.
  const DEFAULT_LOFI = 'https://www.youtube.com/live/rFZHOHl-L8A';
  const ytId = (url) => {
    const m = String(url || '').match(/(?:youtu\.be\/|v=|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/) || String(url || '').match(/^([\w-]{11})$/);
    return m ? m[1] : null;
  };
  const music = {
    on: false,
    playing: false,
    open: false,
    vol: Number(LS.get('pg_lofi_vol', '40')),
    url: LS.get('pg_lofi_url', '') || DEFAULT_LOFI,
    player: null,
    apiReady: null,
  };
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
  dock.innerHTML = `<div class="lofi-head"><b class="lofi-title" data-lofi="expand" title="Показать плеер">${ic('headphones', 16)} Лофи-радио</b><span class="lofi-state muted small"></span><button class="icon-x" data-lofi="close" title="Выключить">${ic('x', 16)}</button></div>
    <div class="lofi-video"><div id="lofi-player"></div></div>
    <div class="lofi-ctl">
      <button class="btn sm icon-btn" data-lofi="toggle" title="Пауза / играть">${ic('pause', 16)}</button>
      <input type="range" min="0" max="100" step="1" data-lofi="vol" aria-label="Громкость"/>
      <button class="btn sm ghost icon-btn" data-lofi="min" title="Свернуть">${ic('chevron', 16)}</button>
    </div>
    <button class="link-btn small" data-lofi="url">другая трансляция…</button>`;
  document.body.appendChild(dock);
  dock.querySelector('[data-lofi="vol"]').value = music.vol;

  function syncMusicUI() {
    dock.hidden = !music.on;
    dock.classList.toggle('mini', !music.open);
    dock.querySelector('[data-lofi="toggle"]').innerHTML = ic(music.playing ? 'pause' : 'play', 16);
    dock.querySelector('.lofi-state').textContent = music.playing ? 'играет' : 'на паузе';
    const hb = document.querySelector('[data-act="lofi"]');
    if (hb) hb.classList.toggle('on', music.playing);
  }
  async function startMusic() {
    const id = ytId(music.url) || ytId(DEFAULT_LOFI);
    music.on = true;
    music.open = true;
    syncMusicUI();
    try {
      await loadYT();
      if (music.player) {
        music.player.loadVideoById(id);
        return;
      }
      music.player = new YT.Player('lofi-player', {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: (e) => {
            e.target.setVolume(music.vol);
            e.target.playVideo();
          },
          onStateChange: (e) => {
            music.playing = e.data === 1 || e.data === 3;
            syncMusicUI();
          },
          onError: () => toast('Трансляция недоступна — попробуйте другую ссылку'),
        },
      });
    } catch {
      document.getElementById('lofi-player').outerHTML = `<iframe id="lofi-player" src="https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
      music.playing = true;
      syncMusicUI();
    }
  }
  function stopMusic() {
    try {
      music.player && music.player.stopVideo();
    } catch {}
    const f = document.querySelector('iframe#lofi-player');
    if (f && !music.player) f.src = 'about:blank';
    music.on = false;
    music.playing = false;
    syncMusicUI();
  }
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lofi]');
    if (!b) return;
    const a = b.dataset.lofi;
    if (a === 'close') stopMusic();
    else if (a === 'expand') {
      music.open = true;
      syncMusicUI();
    } else if (a === 'min') {
      music.open = false;
      syncMusicUI();
    } else if (a === 'toggle') {
      if (!music.player) return;
      music.playing ? music.player.pauseVideo() : music.player.playVideo();
    } else if (a === 'url') {
      const u = prompt('Ссылка на YouTube-трансляцию или видео:', music.url);
      if (u === null) return;
      if (!u.trim()) {
        music.url = DEFAULT_LOFI;
        LS.set('pg_lofi_url', '');
      } else if (!ytId(u)) return toast('Не похоже на ссылку YouTube');
      else {
        music.url = u.trim();
        LS.set('pg_lofi_url', music.url);
      }
      startMusic();
    }
  });
  dock.addEventListener('input', (e) => {
    if (e.target.dataset.lofi !== 'vol') return;
    music.vol = Number(e.target.value);
    LS.set('pg_lofi_vol', String(music.vol));
    try {
      music.player && music.player.setVolume(music.vol);
    } catch {}
  });

  // ---------- маршрутизация ----------
  function codeFromUrl() {
    const m = location.pathname.match(/^\/r\/([A-Za-z]{4})/) || location.hash.match(/^#([A-Za-z]{4})/);
    return m ? m[1].toUpperCase() : null;
  }
  const roomLink = (code) => `${location.origin}/r/${code}`;
  const identity = () => {
    const profile = LS.get('pg_profile', '') || null;
    return {
      profile,
      name: profile ? PROFILES.find((p) => p.id === profile)?.name || '' : LS.get('pg_name', ''),
      avatar: loadAvatar(),
    };
  };

  async function joinRoom(code) {
    const id = identity();
    if ((!id.profile && !id.name) || !id.avatar) return render();
    const r = await emit('joinRoom', { token, code, ...id });
    if (r.error) {
      history.replaceState(null, '', '/');
      render();
    }
  }

  socket.on('connect', () => {
    connected = true;
    const code = S?.room.code || codeFromUrl();
    if (code) joinRoom(code);
    else render();
  });
  socket.on('disconnect', () => {
    connected = false;
    render();
  });
  socket.on('kicked', () => {
    S = null;
    history.replaceState(null, '', '/');
    toast('Вы покинули комнату', 'info');
    render();
  });
  // Звуки и анимации по изменению состояния игры
  function detectEvents(prev, next) {
    if (!prev) return;
    const me = next.me;
    const pc = prev.room.chat, nc = next.room.chat;
    if (nc.length > pc.length && nc[nc.length - 1]?.pid !== me) Sound.play('pop');
    const a = prev.game, b = next.game;
    if (!b) return;
    if (!a || a.type !== b.type) return Sound.play('start');
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
    } else if (b.type === 'whoami') {
      if (a.turnPid !== b.turnPid) Sound.play(b.turnPid === me ? 'myturn' : 'turn');
      if (b.finishOrder.length > a.finishOrder.length) Sound.play('good');
    }
  }

  socket.on('state', (st) => {
    offset = st.serverNow - Date.now();
    const prevKey = S?.game ? S.game.type + (S.game.round || '') : null;
    detectEvents(S, st);
    S = st;
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
  });

  // Нельзя случайно закрыть вкладку посреди игры
  window.addEventListener('beforeunload', (e) => {
    if (S && S.game) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  Promise.all([fetch('/api/games').then((r) => r.json()), fetch('/api/profiles').then((r) => r.json())]).then(([g, p]) => {
    GAMES = g;
    PROFILES = p;
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
  function render() {
    const keep = snapshotInputs();
    const chatEl = $app.querySelector('.chat-log');
    const chatScroll = chatEl?.scrollTop;
    const nearBottom = !chatEl || chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
    const sk = screenKey();
    ui.enter = sk !== ui.lastScreen;
    ui.lastScreen = sk;
    const rb = $app.querySelector('.rl-body');
    const rulesScroll = rb && rb.dataset.g === String(ui.showRules) ? rb.scrollTop : 0;
    $app.innerHTML = S ? renderRoom() : renderHome();
    ui.popAnim = false;
    ui.rulesAnim = false;
    restoreInputs(keep);
    const rb2 = $app.querySelector('.rl-body');
    if (rb2) {
      rb2.scrollTop = rulesScroll;
      if (ui.rulesTabScroll) $app.querySelector('.rl-tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
      ui.rulesTabScroll = false;
    }
    const c = $app.querySelector('.chat-log');
    if (c) c.scrollTop = nearBottom ? c.scrollHeight : chatScroll;
    fitBoard();
    tick();
  }

  // Ключ «экрана»: когда он меняется — плавно проявляем новую сцену
  function screenKey() {
    if (!S) return 'home:' + ui.homeStep;
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
    fitT = setTimeout(fitBoard, 80);
  });

  // ---------- конструктор аватара ----------
  function avatarEditor(av, scope) {
    const rows = PixelAvatar.KEYS.map((k) => {
      const opts = Array.from({ length: 10 }, (_, v) => {
        const on = av[k] === v;
        if (PixelAvatar.COLOR_KEYS.includes(k))
          return `<button type="button" class="sw-opt ${on ? 'on' : ''}" style="--c:${PixelAvatar.PAL[k][v]}" data-act="av-set" data-scope="${scope}" data-k="${k}" data-v="${v}" title="${v + 1}"></button>`;
        const prev = { ...PixelAvatar.BASE, [k]: v };
        return `<button type="button" class="av-opt ${on ? 'on' : ''}" data-act="av-set" data-scope="${scope}" data-k="${k}" data-v="${v}" title="${esc(PixelAvatar.NAMES[k][v])}">${PixelAvatar.svg(prev, 40, '#3a3748')}</button>`;
      }).join('');
      return `<div class="av-row"><div class="av-lbl">${PixelAvatar.LABEL[k]}${PixelAvatar.NAMES[k] ? `<span class="muted">${esc(PixelAvatar.NAMES[k][av[k]])}</span>` : ''}</div><div class="av-opts">${opts}</div></div>`;
    }).join('');
    return `<div class="av-editor">
      <div class="av-preview">
        <div class="av-big">${PixelAvatar.svg(av, 160, PixelAvatar.NEUTRAL)}</div>
        <button type="button" class="btn sm" data-act="av-random" data-scope="${scope}">${ic('dice5', 16)} Случайно</button>
        <p class="muted small av-note">Фон подберётся сам: цвет команды в командных играх, свой цвет — в остальных.</p>
      </div>
      <div class="av-params">${rows}</div>
    </div>`;
  }

  // ---------- вход ----------
  function renderHome() {
    const code = codeFromUrl();
    const sel = ui.homeSel;
    const header = `<div class="home-top">${themeMenu()}</div>`;
    const hero = `<div class="home-hero">
        <div class="logo-mark">${ic('dice', 40)}</div>
        <h1>Экранки <span>а не настолки — для своих</span></h1>
        <p class="lead">Коднеймс, Элиас, Шпион, Кто я и Намёк понял — по одной или марафоном с турнирной таблицей.</p>
      </div>`;
    if (ui.homeStep === 'avatar' && sel) {
      const name = sel === 'new' ? LS.get('pg_name', '') : PROFILES.find((p) => p.id === sel)?.name;
      return `${header}<main class="home wide">
        <form class="card home-card" data-form="enter">
          <div class="step-h"><button type="button" class="btn sm ghost" data-act="home-back">${ic('back', 16)} Назад</button><span class="lbl">Шаг 2 из 2 · Твой персонаж на эту игру</span></div>
          <h2 class="h2">Привет, ${esc(name || 'игрок')}! Собери аватар</h2>
          ${avatarEditor(ui.avatar, 'home')}
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
      </main>`;
    }
    // На шаге 1 аватара ещё нет — только инициалы
    const tiles = PROFILES.map((p) =>
      `<button type="button" class="pick-tile ${sel === p.id ? 'on' : ''}" data-act="home-pick" data-id="${p.id}">${avaHtml({ name: p.name }, 'lg')}<span>${esc(p.name)}</span></button>`
    ).join('');
    return `${header}<main class="home">
      ${hero}
      <form class="card home-card" data-form="who">
        <span class="lbl">Шаг 1 из 2 · Кто ты?</span>
        <div class="pick-grid">
          ${tiles}
          <button type="button" class="pick-tile new ${sel === 'new' ? 'on' : ''}" data-act="home-pick" data-id="new"><span class="ava lg plus" style="width:${SIZES.lg}px;height:${SIZES.lg}px">${ic('plus', 24)}</span><span>Новый игрок</span></button>
        </div>
        ${sel === 'new' ? `<input class="inp" name="name" data-keep="home-name" maxlength="24" placeholder="Как тебя зовут?" value="${esc(LS.get('pg_name', ''))}" autocomplete="nickname" />` : ''}
        <button class="btn primary big" type="submit" ${sel ? '' : 'disabled'}>Дальше — аватар</button>
      </form>
    </main>`;
  }

  // ---------- комната ----------
  function renderRoom() {
    const r = S.room;
    const g = S.game;
    const t = tour();
    const meta = gameMeta(g ? g.type : ui.selected);
    let stage;
    if (t && t.phase === 'final') stage = renderTourFinal();
    else if (g) stage = (t ? renderTourStrip() + renderTourBetween() : '') + renderGame(g);
    else stage = renderLobby();
    const title = g ? `${gIcon(g.type)}<span>${esc(meta.title)}</span>` : t ? `${ic('trophy')}<span>Марафон</span>` : `<span class="muted">Лобби</span>`;
    return `
    <div class="room ${g ? 'in-game game-' + g.type : 'in-lobby'}">
      <header class="topbar">
        <div class="tb-row">
          <div class="brand">${ic('dice', 22)}<b>Экранки</b></div>
          <div class="gtitle">${title}</div>
          <div class="top-actions">
            ${g || !t ? `<button class="btn sm ghost" data-act="rules" title="Правила">${ic('book')}<span class="hide-m">Правила</span></button>` : ''}
            <button class="btn sm ghost icon-btn lofi-btn ${music.playing ? 'on' : ''}" data-act="lofi" title="Лофи-радио">${ic('headphones')}</button>
            ${sfxMenu()}
            ${themeMenu()}
            <button class="btn sm code-btn" data-act="copy" title="Скопировать ссылку на комнату">${ic('link', 16)}<span>${esc(r.code)}</span></button>
          </div>
        </div>
        ${renderStrip()}
        ${g && g.type === 'codenames' ? renderClock(g) : ''}
      </header>
      ${!connected ? '<div class="offline">Нет соединения, переподключаемся…</div>' : ''}
      <main class="stage ${ui.enter ? 'enter' : ''}">
        ${stage}
      </main>
      ${renderChat()}
      ${ui.showRules ? renderRules() : ''}
      ${ui.avEdit ? renderAvatarModal() : ''}
    </div>`;
  }

  // Второй этаж хедера: все игроки и зрители
  function renderStrip() {
    const r = S.room;
    const g = S.game;
    const cn = g && g.type === 'codenames' ? g : null;
    const people = r.players
      .map((p) => {
        const team = cn ? cn.team[p.id] : null;
        const cap = cn && (cn.captain.red === p.id || cn.captain.blue === p.id);
        const tag = cn ? (team ? (cap ? 'капитан' : '') : 'зритель') : '';
        const open = ui.menu === 'p:' + p.id;
        const mine = p.id === S.me;
        const items = [];
        if (mine) items.push(`<button class="pop-i" data-act="av-open">${ic('palette', 16)}<span>Изменить аватар</span></button>`);
        if (mine && !p.profile && !g) items.push(`<button class="pop-i" data-act="rename">${ic('pencil', 16)}<span>Изменить имя</span></button>`);
        if (isHost() && !mine) {
          items.push(`<button class="pop-i" data-act="makeHost" data-pid="${p.id}">${ic('crown', 16)}<span>Сделать хостом</span></button>`);
          items.push(`<button class="pop-i danger" data-act="kick" data-pid="${p.id}">${ic('x', 16)}<span>Выгнать</span></button>`);
        }
        return `<div class="menu-wrap" data-pop>
          <button class="pm ${p.connected ? '' : 'off'} ${mine ? 'me' : ''}" ${items.length ? `data-act="menu" data-menu="p:${p.id}"` : ''} title="${esc(p.name)}${p.connected ? '' : ' — офлайн'}">
            ${avaHtml(p, 26, 'round')}
            <span class="pm-n">${esc(p.name)}</span>
            ${p.id === r.hostId ? `<span class="pm-host" title="Хост">${ic('crown', 13)}</span>` : ''}
            ${tag ? `<span class="pm-tag">${tag}</span>` : ''}
          </button>
          ${open && items.length ? `<div class="pop">${items.join('')}</div>` : ''}
        </div>`;
      })
      .join('');
    return `<div class="tb-strip">
      <span class="strip-l">${ic('users', 16)}<b>${r.players.length}</b></span>
      <div class="strip-list">${people}</div>
      ${!g && !tour() ? `<button class="btn sm ghost leave-btn" data-act="leave" title="Выйти из комнаты">${ic('logout', 16)}<span class="hide-m">Выйти</span></button>` : ''}
    </div>`;
  }

  function renderChat() {
    const r = S.room;
    const g = S.game;
    if (ui.chatOpen) ui.chatSeen = r.chat.length;
    const unread = Math.max(0, r.chat.length - ui.chatSeen);
    const hostTools = g && isHost();
    const ctlOpen = hostTools && ui.menu === 'ctl';
    return `<div class="chat-dock ${ui.chatOpen ? 'open' : ''}">
      ${
        ui.chatOpen
          ? `<div class="chat-panel card">
              <div class="chat-h"><b>${ic('chat', 16)} Чат</b><button class="icon-x" data-act="chat" title="Свернуть">${ic('chevron', 18)}</button></div>
              <div class="chat-log">${r.chat.length ? r.chat.map((m) => `<div class="msg">${pa(m.pid, 'xs')}<div><b>${esc(m.name)}</b> ${esc(m.text)}</div></div>`).join('') : '<div class="muted small">Сообщений пока нет</div>'}</div>
              <form data-form="chat" class="chat-form"><input class="inp" name="text" data-keep="chat" maxlength="300" placeholder="Сообщение…" autocomplete="off"/><button class="btn sm primary icon-btn" title="Отправить">${ic('send', 16)}</button></form>
            </div>`
          : ''
      }
      <div class="fab-row">
        ${
          hostTools
            ? `<div class="menu-wrap" data-pop>
                <button class="chat-fab gear ${ctlOpen ? 'on' : ''}" data-act="menu" data-menu="ctl" title="Управление игрой (хост)">${ic('gear', 22)}${g.clock?.paused ? '<i class="badge warn-b">II</i>' : ''}</button>
                ${ctlOpen ? renderControls(g) : ''}
              </div>`
            : ''
        }
        <button class="chat-fab" data-act="chat" title="${ui.chatOpen ? 'Свернуть чат' : 'Чат'}">${ic(ui.chatOpen ? 'x' : 'chat', 22)}${unread && !ui.chatOpen ? `<i class="badge">${unread > 9 ? '9+' : unread}</i>` : ''}</button>
      </div>
    </div>`;
  }

  function renderAvatarModal() {
    return `<div class="modal-bg" data-act="av-cancel"></div>
      <div class="modal card" role="dialog" aria-label="Аватар">
        <div class="modal-h"><b>Твой аватар</b><button class="icon-x" data-act="av-cancel">${ic('x', 18)}</button></div>
        ${avatarEditor(ui.avEdit, 'room')}
        <div class="row end"><button class="btn ghost" data-act="av-cancel">Отмена</button><button class="btn primary" data-act="av-save">Сохранить</button></div>
      </div>`;
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
    const btn = (actName, icon, label, cls = '') => `<button class="ctl ${cls}" data-act="${actName}">${ic(icon, 18)}<span>${label}</span></button>`;
    const items = [];
    if (g.type === 'codenames') {
      if (isPrep(g)) items.push(btn('cn-force', 'play', 'Начать без ожидания'));
      if (g.clock) items.push(btn('cn-pause', g.clock.paused ? 'play' : 'pause', g.clock.paused ? 'Продолжить таймер' : 'Пауза таймера', g.clock.paused ? 'hot' : ''));
      if (!g.winner) items.push(btn('cn-reset', 'reset', 'Перезапустить таймер'));
      items.push(btn('cn-shuffle', 'shuffle', 'Перемешать команды'));
      if (!t) items.push(btn('cn-new', 'grid', 'Новая доска'));
      if (!g.winner) items.push(btn('cn-end', 'skip', 'Передать ход'));
    } else if (g.type === 'alias') {
      if (['ready', 'running', 'review'].includes(g.phase)) items.push(btn('al-skipturn', 'skip', 'Пропустить ход'));
      if (g.phase === 'teams') items.push(btn('al-shuffle', 'shuffle', 'Перемешать команды'));
      if (!t) items.push(btn('al-restart', 'reset', 'Начать заново'));
    } else if (g.type === 'spyfall') {
      if (g.phase !== 'over') items.push(btn('spy-reveal', 'eye', 'Открыть карты'));
      if (!t) items.push(btn('spy-next', 'reset', 'Новый раунд'));
    } else if (g.type === 'whoami') {
      if (g.phase === 'play') items.push(btn('who-next', 'skip', 'Передать ход'));
      if (g.phase === 'write') items.push(btn('who-force', 'play', 'Начать сейчас'));
    } else if (g.type === 'justone') {
      if (g.phase === 'clues') items.push(btn('jo-force', 'skip', 'Не ждать остальных'));
      if (!t) items.push(btn('jo-restart', 'reset', 'Начать заново'));
    }
    items.push('<span class="ctl-sep"></span>');
    items.push(btn('stop', 'home', 'В лобби (пауза)'));
    return `<div class="pop ctl-pop ${ui.popAnim ? 'anim' : ''}"><div class="ctl-h">${ic('crown', 14)} Управление игрой</div>${items.join('')}</div>`;
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
    if (!host)
      return `<div class="lobby">${paused}${invite}<div class="card center big-pad"><div class="big-ic">${ic('dice', 44)}</div><h2 class="h2">Хост выбирает игру</h2>
        <p class="muted">${nm(S.room.hostId)} настраивает игру или марафон. Пока можно почитать правила.</p></div>
        <div class="games-grid">${GAMES.map((x) => gameCard(x, false, sel)).join('')}</div></div>`;
    const tabs = `<div class="tabs"><button class="${ui.mode === 'single' ? 'on' : ''}" data-act="mode" data-m="single">${ic('grid', 16)} Одна игра</button><button class="${ui.mode === 'tour' ? 'on' : ''}" data-act="mode" data-m="tour">${ic('trophy', 16)} Марафон</button></div>`;
    if (ui.mode === 'tour') return `<div class="lobby">${paused}${invite}${tabs}${renderTourBuilder()}</div>`;
    return `<div class="lobby">${paused}${invite}${tabs}
      <div class="games-grid">${GAMES.map((x) => gameCard(x, true, sel)).join('')}</div>
      <div class="card settings">
        <div class="settings-h"><b>${gIcon(meta.id)} ${esc(meta.title)}</b> <button class="link-btn" data-act="rules">как играть и как считаются очки?</button></div>
        <form data-form="start" class="set-form">
          ${(meta.settings || []).map((x) => renderSetting(x)).join('')}
          <button class="btn primary big" type="submit">${ic('play', 16)} Начать игру</button>
        </form>
      </div></div>`;
  }

  const gameCard = (g, clickable, sel) => `<button class="gcard ${g.id === sel && clickable ? 'active' : ''}" ${clickable ? `data-act="pick" data-id="${g.id}"` : 'disabled'}>
      <span class="gemoji">${gIcon(g.id, 28)}</span>
      <span class="gname">${esc(g.title)}</span>
      <span class="gshort">${esc(g.short)}</span>
      <span class="gplayers">${ic('users', 14)} ${esc(g.players)}</span>
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
  function renderTourBuilder() {
    let total = 0;
    const rows = ui.mOrder
      .map((id, k) => {
        const m = gameMeta(id);
        const on = !!ui.mOn[id];
        const rounds = ui.mRounds[id] || 1;
        if (on) total += rounds;
        return `<div class="mrow ${on ? 'on' : ''}">
          <div class="mhead">
            <label class="mcheck"><input type="checkbox" data-mon="${id}" ${on ? 'checked' : ''}/><span class="mname">${gIcon(id)} ${esc(m.title)}</span></label>
            <div class="mctl">
              ${on ? `<span class="muted small hide-m">каток</span><div class="stepper"><button type="button" data-act="m-rounds" data-id="${id}" data-d="-1">−</button><b>${rounds}</b><button type="button" data-act="m-rounds" data-id="${id}" data-d="1">+</button></div>` : ''}
              <button type="button" class="icon-x mv" data-act="m-move" data-id="${id}" data-d="-1" ${k === 0 ? 'disabled' : ''} title="Выше">${ic('up', 16)}</button>
              <button type="button" class="icon-x mv" data-act="m-move" data-id="${id}" data-d="1" ${k === ui.mOrder.length - 1 ? 'disabled' : ''} title="Ниже">${ic('down', 16)}</button>
            </div>
          </div>
          ${on && (m.settings || []).length ? `<details class="mset" data-mopen="${id}" ${ui.mOpen[id] ? 'open' : ''}><summary>Настройки</summary><div class="set-form">${m.settings.map((x) => renderSetting(x, id + '__')).join('')}</div></details>` : ''}
        </div>`;
      })
      .join('');
    return `<form data-form="tour" class="card tour-form">
        <div class="settings-h"><b>${ic('trophy')} Марафон</b><span class="muted small">Отметьте игры, задайте порядок и число каток</span></div>
        ${rows}
        <div class="mfoot"><span>Всего: <b>${total}</b> ${plural(total, 'катка', 'катки', 'каток')}</span><button class="btn primary" type="submit" ${total ? '' : 'disabled'}>${ic('trophy', 16)} Начать марафон</button></div>
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
          return `<tr class="${r.id === S.me ? 'me' : ''}"><td>${place}</td><td>${player(r.id) ? who(r.id, 'sm') : '<span class="muted">ушёл</span>'}</td>${types.map((ty) => `<td>${r.per[ty] || 0}</td>`).join('')}<td><b>${r.total}</b></td></tr>`;
        })
        .join('')}</tbody></table></div>`;
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
      ${tourTable()}
      ${isHost() ? `<div class="row c"><button class="btn primary" data-act="tour-end">${ic('home', 16)} Вернуться в лобби</button></div>` : ''}
    </div>`;
  }

  // ---------- игры ----------
  function renderGame(g) {
    const fn = { codenames: rCodenames, alias: rAlias, spyfall: rSpy, whoami: rWho, justone: rJust }[g.type];
    return fn ? fn(g) : '<p>Неизвестная игра</p>';
  }
  const canRestart = () => isHost() && !tour();

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
  function tick() {
    const n = now();
    // тикаем последние 5 секунд таймера хода
    const clk = document.querySelector('[data-clock]') || document.querySelector('.stage [data-ends]');
    if (clk && clk.dataset.paused !== '1') {
      const sec = Math.ceil((Number(clk.dataset.ends) - n) / 1000);
      if (sec >= 1 && sec <= 5 && sec !== lastTickSec) Sound.play('tick');
      lastTickSec = sec;
    }
    document.querySelectorAll('[data-ends]').forEach((el) => {
      const left = Number(el.dataset.ends) - n;
      const t = el.querySelector('.t');
      if (t) t.textContent = fmt(left);
      const total = Number(el.dataset.total) * 1000;
      const bar = el.querySelector('i');
      if (bar && total) bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
      el.classList.toggle('low', left < 10000);
    });
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
      .map(([id, n], i) => `<div class="lrow ${id === mark ? 'turn' : ''} ${id === S.me ? 'me' : ''}"><span>${i === 0 && n > 0 ? `<span class="medal">${ic('medal', 14)}</span>` : ''}${who(id, 'sm')}</span><b>${n}</b></div>`)
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
  const STRENGTH_RE = /^(0?[.,]\d{1,2}|1([.,]0{1,2})?|0)$/;
  const validStrength = (v) => STRENGTH_RE.test(String(v).trim()) && parseFloat(String(v).replace(',', '.')) > 0;
  const TN = { red: 'Красные', blue: 'Синие' };
  const TNg = { red: 'красных', blue: 'синих' };

  // Чипы подсказки: активные — белые, зачёркнутые — погашены. Капитан своей команды кликает, чтобы зачеркнуть
  const clueChips = (c, canStrike) =>
    c.slots
      .map((x, k) => {
        const title = x.done ? 'зачёркнуто' : `подходит на ${Math.round(x.v * 100)}%`;
        return canStrike
          ? `<button type="button" class="num ${x.done ? 'done' : ''} can" data-act="cn-strike" data-clue="${c.id}" data-k="${k}" title="${title} · нажмите, чтобы ${x.done ? 'вернуть' : 'зачеркнуть'}">${fmtV(x.v)}</button>`
          : `<span class="num ${x.done ? 'done' : ''}" title="${title}">${fmtV(x.v)}</span>`;
      })
      .join('');
  function cluePreview() {
    const word = $app.querySelector('.clue-word')?.value.trim() || 'слово';
    return `<span class="pv-word">${esc(word)}</span> ${(ui.cnSlots || []).map((x) => `<span class="num ${validStrength(x.v) ? '' : 'bad'}">${esc(String(x.v).replace(',', '.') || '?')}</span>`).join(' ')}`;
  }
  const ring = (cls = '', off = null) =>
    `<svg class="ring ${cls}" viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15.9"/><circle class="ring-fg" cx="18" cy="18" r="15.9" pathLength="100"${off != null ? ` style="stroke-dashoffset:${Math.max(0, Math.min(100, off))}"` : ''}/></svg>`;

  const prepPool = (g) => Object.keys(g.team).filter((id) => player(id)?.connected);
  const isPrep = (g) => g.step === 'setup' || (g.winner && !tour());

  function renderClock(g) {
    const c = g.clock;
    if (!c) {
      const pool = prepPool(g);
      const n = pool.filter((id) => g.ready[id]).length;
      return `<div class="clockbar idle"><div class="ck-txt">${ic(g.winner ? 'trophy' : 'users', 14)}<span>${g.winner ? 'Партия окончена' : 'Подготовка к партии'}</span>${isPrep(g) ? `<span class="ck-phase">готовы ${n} из ${pool.length}</span>` : ''}</div></div>`;
    }
    const phase = g.step === 'clue' ? 'капитан думает' : 'команда отгадывает';
    const left = c.paused ? c.left : c.endsAt - now();
    const w = Math.max(0, Math.min(100, (left / c.total) * 100));
    return `<div class="clockbar t-${g.turn} ${c.paused ? 'paused' : ''} ${!c.paused && left < 10000 ? 'low' : ''}" data-clock data-ends="${c.endsAt}" data-left="${c.left}" data-total="${c.total}" data-paused="${c.paused ? 1 : 0}">
      <div class="ck-fill" style="width:${w}%"></div>
      <div class="ck-txt"><span class="ck-team">${TN[g.turn]}</span><span class="ck-phase">${phase}</span>${c.paused ? `<span class="ck-p">${ic('pause', 12)} пауза</span>` : ''}<span class="ck-t">${fmt(left)}</span></div>
    </div>`;
  }

  function clueForm(g, mode) {
    if (!ui.cnSlots) ui.cnSlots = [{ id: slotId(), v: '1' }];
    const slots = ui.cnSlots
      .map(
        (x, k) => `<div class="slot ${validStrength(x.v) ? '' : 'bad'}">
          <span class="slot-n">${k + 1}</span>
          <input type="range" min="0.01" max="1" step="0.01" value="${validStrength(x.v) ? parseFloat(String(x.v).replace(',', '.')) : 1}" data-slot="${x.id}" data-kind="range" aria-label="Сила слова ${k + 1}"/>
          <input class="inp slot-v" inputmode="decimal" maxlength="4" value="${esc(x.v)}" data-slot="${x.id}" data-kind="num" data-keep="cn-s-${x.id}" aria-label="Сила слова ${k + 1}"/>
          ${ui.cnSlots.length > 1 ? `<button type="button" class="icon-x" data-act="cn-sdel" data-id="${x.id}" title="Убрать слово">${ic('x', 14)}</button>` : '<span class="slot-gap"></span>'}
        </div>`
      )
      .join('');
    const word = mode === 'edit' ? esc(g.clue.word) : '';
    return `<form class="cn-clue form t-${g.turn}" data-form="clue" data-mode="${mode}">
      <div class="clue-inputs">
        <input class="inp clue-word" name="word" data-keep="cn-clue${mode === 'edit' ? '-e' : ''}" data-preview="1" value="${word}" placeholder="Подсказка — одно слово" maxlength="30" autocomplete="off" required/>
        ${mode === 'edit' ? `<button type="button" class="btn ghost" data-act="cn-edit-cancel">Отмена</button>` : ''}
        <button class="btn primary">${mode === 'edit' ? `${ic('check', 16)} Сохранить` : `${ic('send', 16)} Отправить`}</button>
      </div>
      <div class="slots"><span class="slots-l" title="1 — точно подходит, 0.73 — подходит на 73%">Сила слов</span>${slots}${ui.cnSlots.length < 9 ? `<button type="button" class="btn ghost add-slot" data-act="cn-sadd" title="Добавить ещё одно слово">${ic('plus', 16)}</button>` : ''}</div>
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
    const rd = (id) => (prep && g.ready[id] ? `<span class="rd" title="Готов">${ic('check', 11)}</span>` : '');
    const capBlock = cap
      ? `<div class="tp-cap">${pa(cap, 'md')}${rd(cap)}<div class="tp-cap-n"><span>${nm(cap)}</span><span class="tp-role">${ic('crown', 12)} капитан</span></div></div>
         ${amCapHere && prep ? `<button class="btn tp-leave" data-act="cn-join" data-team="${t}">${ic('logout', 16)} Уступить место капитана</button>` : ''}`
      : prep || !myTeam || myTeam === t
        ? `<button class="tp-become" data-act="cn-cap" data-team="${t}">${ic('crown', 18)}<span>Стать капитаном</span></button>`
        : `<div class="tp-empty muted small">${ic('crown', 14)} капитана нет</div>`;
    return `<aside class="cn-side t-${t} ${turn ? 'turn' : ''}">
      <div class="tp-head">
        <span class="tp-name">${TN[t]}</span>
        <span class="tp-left"><b>${g.left[t]}</b><small>осталось</small></span>
      </div>
      ${turn ? `<div class="tp-turn">${ic('clock', 14)} ${g.step === 'clue' ? 'Капитан думает' : 'Отгадывают'}</div>` : ''}
      <div class="tp-sec"><div class="tp-label">Капитан</div>${capBlock}</div>
      <div class="tp-sec"><div class="tp-label">Агенты · ${members.length}</div>
        <div class="tp-agents">${members.map((id) => `<div class="tp-agent ${id === me ? 'me' : ''}"><span class="ava-wrap">${pa(id, 'sm')}${rd(id)}</span><span>${nm(id)}</span></div>`).join('') || '<span class="muted small">пока никого</span>'}</div>
      </div>
      ${myTeam !== t && (prep || !myTeam) ? `<button class="btn tp-join" data-act="cn-join" data-team="${t}">${ic('userplus', 18)} ${myTeam ? 'Перейти' : 'Играть'} за ${TNg[t]}</button>` : myTeam === t && !amCapHere ? `<div class="tp-in">${ic('check', 14)} Вы в этой команде</div>` : !prep && myTeam && myTeam !== t ? `<div class="tp-in muted">${ic('clock', 14)} Сменить команду можно после партии</div>` : ''}
      <div class="tp-sec tp-clues"><div class="tp-label">Подсказки</div>${
        clues.length
          ? clues
              .map(
                (c) => `<div class="hrow ${g.clue && g.clue.id === c.id && !g.winner ? 'now' : ''} ${c.slots.every((x) => x.done) ? 'alldone' : ''}"><span class="hword">${esc(c.word)}</span><span class="hnums">${clueChips(c, cap === me)}</span></div>`
              )
              .join('')
          : '<span class="muted small">ещё не было</span>'
      }</div>
    </aside>`;
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
          ? clueForm(g, 'new')
          : `<div class="cn-clue t-${g.turn}"><div class="cl-main"><span class="cl-label">Ход ${TNg[g.turn]}</span><span class="cl-word sm muted">${g.captain[g.turn] ? `${nm(g.captain[g.turn])} придумывает подсказку…` : 'Нужен капитан — нажмите «Стать капитаном» в панели команды'}</span></div></div>`;
    else if (ui.cnEdit && g.clue.by === me && now() < g.clue.editUntil) status = clueForm(g, 'edit');
    else {
      const c = g.clue;
      const canEdit = c.by === me && now() < c.editUntil;
      status = `<div class="cn-clue t-${g.turn}">
        <div class="cl-main"><span class="cl-label">Подсказка от ${nm(c.by)}</span><span class="cl-word">${esc(c.word)}</span></div>
        <div class="cl-nums">${clueChips(c, g.captain[c.team] === me)}</div>
        ${canEdit ? `<button class="btn sm edit-btn" data-act="cn-edit" data-until="${c.editUntil}" data-span="15000" title="Можно исправить в течение 15 секунд">${ring('', 100 - ((c.editUntil - now()) / 15000) * 100)}<span>${ic('pencil', 14)} Исправить</span><span class="secs">${Math.ceil((c.editUntil - now()) / 1000)}</span></button>` : ''}
        ${amAgentNow ? `<button class="btn primary big-w cta-pass" data-act="cn-end">${ic('skip', 18)} Передать ход</button>` : ''}
      </div>
      <p class="cn-wait small muted">${amAgentNow ? `Кликните по карточке, чтобы проголосовать. Когда все агенты (${g.agentsNow}) выберут одну — через 2 секунды она откроется.` : myTurn && amCap ? 'Ваша команда выбирает карточки' : `Отгадывают ${TNg[g.turn]}`}</p>`;
    }

    const cards = g.cards
      .map((c, i) => {
        const pend = g.pending && g.pending.i === i;
        const elapsed = pend ? Math.max(0, g.pending.ms - (g.pending.at - now())) : 0;
        if (g.step === 'setup') return `<div class="cn-card blank" style="--i:${i}">${ic('grid', 18)}</div>`;
        return `<button class="cn-card ${c.color ? 'c-' + c.color : ''} ${c.revealed ? 'rev' : ''} ${c.marks.includes(me) ? 'mine' : ''} ${pend ? 'pending' : ''} ${ui.flip && ui.flip.has(i) ? 'flip' : ''} ${ui.enter && g.step === 'clue' ? 'deal' : ''}" style="--i:${i};${ui.flip && ui.flip.has(i) ? `--fd:-${Date.now() - ui.flip.get(i)}ms` : ''}" data-act="cn-mark" data-i="${i}">
          <span class="w" lang="ru">${hy(c.w)}</span>
          ${c.marks.length ? `<span class="marks">${c.marks.map((m) => pa(m, 'xs')).join('')}</span>` : ''}
          ${pend ? `<span class="pend" style="--d:${g.pending.ms}ms;--e:-${elapsed}ms">${ring('fill')}</span>` : ''}
        </button>`;
      })
      .join('');
    return `
      <div class="cn">
        ${teamPanel(g, 'red')}
        <section class="cn-center">
          <div class="cn-status">${status}</div>
          <div class="cn-board ${amCap ? 'captain own-' + myTeam : ''} ${amCap || g.winner ? 'allcolors' : ''}">${cards}</div>
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
                        : l.kind === 'timeout'
                          ? `${ic('clock', 14)} ${esc(l.by)}: время вышло`
                          : `${ic('grid', 14)} ${esc(l.by)} открыли <b>${esc(l.text)}</b> <span class="sw c-${l.color}"></span>`
                }</div>`
            )
            .join('') || '<div class="muted small">Пока пусто</div>'}</details>
        </section>
        ${teamPanel(g, 'blue')}
      </div>`;
  }

  // ===== Элиас: команды по бокам, слово и две большие кнопки по центру =====
  function aliasTeam(g, i) {
    const t = g.teams[i];
    const turn = i === g.turnTeam && !['teams', 'over'].includes(g.phase);
    return `<aside class="side-team ${turn ? 'turn' : ''} ${i === g.myTeam ? 'mine' : ''}" style="--tc:${ALIAS_BG[i]}">
      <div class="tp-head"><span class="tp-name">${esc(t.name)}</span><span class="tp-left"><b>${t.score}</b><small>из ${g.target}</small></span></div>
      ${turn ? `<div class="tp-turn">${ic('mic', 14)} Ход команды</div>` : ''}
      <div class="tp-agents">${
        t.members.map((id) => `<div class="tp-agent ${id === S.me ? 'me' : ''}">${pa(id, 'sm')}<span>${nm(id)}</span>${id === g.explainer && turn ? `<span class="tp-role">${ic('mic', 12)} объясняет</span>` : ''}</div>`).join('') ||
        '<span class="muted small">пока никого</span>'
      }</div>
      ${g.phase === 'teams' && i !== g.myTeam ? `<button class="btn tp-join" data-act="al-join" data-team="${i}">${ic('userplus', 18)} В эту команду</button>` : i === g.myTeam ? `<div class="tp-in">${ic('check', 14)} Вы в этой команде</div>` : ''}
    </aside>`;
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
        ${timerHtml(g.endsAt, g.seconds)}
        ${g.word ? `<div class="mega-word">${esc(g.word)}</div>` : `<div class="mega-word hidden">?</div><p class="muted">Слушайте ${nm(g.explainer)} и угадывайте!</p>`}
        ${isExpl ? `<div class="mega-row"><button class="btn danger mega" data-act="al-skip">${ic('x', 26)} Пропуск${g.penalty ? ' −1' : ''}</button><button class="btn success mega" data-act="al-got">${ic('check', 26)} Угадали +1</button></div>` : ''}
        <div class="counters"><span>Угадано <b>${g.guessedNow}</b></span><span>Пропущено <b>${g.skippedNow}</b></span></div>
      </div>`;
    } else if (g.phase === 'review') {
      const canConfirm = isExpl || isHost();
      const lastLabel = (w) => (w.ok === 'own' ? 'угадала своя команда' : typeof w.ok === 'number' ? `угадали «${esc(g.teams[w.ok].name)}»` : 'никто не угадал');
      center = `<div class="stage-card left">
        <div class="kicker">Проверка слов · команда «${esc(team.name)}»</div>
        <p class="small muted">Нажмите на слово, чтобы поменять статус. Угадано +1${g.penalty ? ', пропуск −1' : ''}.</p>
        <div class="review">${
          g.turnWords
            .map(
              (w, i) => `<button class="rw ${w.last ? 'last' : ''} ${w.ok === true || w.ok === 'own' ? 'ok' : typeof w.ok === 'number' ? 'other' : 'no'}" data-act="al-toggle" data-i="${i}">
            <span>${esc(w.w)}</span><em>${w.last ? 'последнее: ' + lastLabel(w) : w.ok ? '+1' : g.penalty ? '−1' : '0'}</em></button>`
            )
            .join('') || '<p class="muted">Ни одного слова</p>'
        }</div>
        <div class="row c">${canConfirm ? `<button class="btn primary big-w" data-act="al-confirm">${ic('check', 18)} Подтвердить очки</button>` : `<span class="muted">Подтверждает ${nm(g.explainer)}</span>`}</div>
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
        ${c.timeUp ? `<p class="warn">${ic('clock', 16)} Минута вышла — решайте!</p>` : timerHtml(c.endsAt, 60)}
        ${me === c.by ? '<p>Говорите вслух в Discord — участники подтвердят.</p>' : '<p class="muted">Слушайте в Discord и решите, угадал ли он.</p>'}
        ${amJudge ? `<div class="row c"><button class="btn ${c.judges[me] === false ? 'danger' : 'ghost'}" data-act="spy-judge" data-ok="0">${ic('x', 16)} Не угадал</button><button class="btn ${c.judges[me] === true ? 'success' : 'ghost'}" data-act="spy-judge" data-ok="1">${ic('check', 16)} Шпион правильно ответил</button></div>` : ''}
        <p class="small muted">Угадал: <b>${yes}</b> · Не угадал: <b>${no}</b> · нужно ${need} из ${townIds.length}</p>
      </div>`;
    }

    const players = g.participants
      .map((id) => {
        const voters = Object.keys(g.votes).filter((v) => g.votes[v] === id);
        return `<div class="vote-row ${g.votes[me] === id ? 'my' : ''}">
          <span>${who(id, 'sm')}${id === g.firstAsks && !over ? ' <em class="small muted">· спрашивает первым</em>' : ''}${over && g.spies.includes(id) ? ` ${ic('spy', 16)}` : ''}</span>
          <span class="voters">${voters.map((v) => pa(v, 'xs')).join('')}</span>
          ${g.phase === 'play' && g.inGame && id !== me ? `<button class="btn xs ${g.votes[me] === id ? 'danger' : ''}" data-act="spy-vote" data-pid="${id}">${g.votes[me] === id ? 'Отозвать' : 'Обвинить'}</button>` : ''}
        </div>`;
      })
      .join('');

    const roundTable = over
      ? `<div class="card"><div class="side-h">Очки за раунд</div>${g.participants
          .map((id) => {
            const r = g.roundPts[id];
            return `<div class="pts-row"><span>${who(id, 'sm')}</span><span class="why small muted">${r ? esc(r.why.join(', ')) : '—'}</span><b class="${r?.pts ? 'plus' : ''}">${r?.pts ? '+' + r.pts : 0}</b></div>`;
          })
          .join('')}</div>`
      : '';
    const score = Object.entries(g.score);
    return `<div class="narrow spyfall">
      <div class="spy-top">${g.phase === 'play' ? timerHtml(g.endsAt, 0) : '<span></span>'}<span class="muted">Раунд ${g.round}</span></div>
      ${card}
      ${g.phase === 'play' && g.isSpy ? `<div class="row c"><button class="btn primary big-w" data-act="spy-claim">${ic('target', 18)} Я знаю локацию</button></div><p class="center small muted">У вас будет минута, чтобы назвать её вслух.</p>` : ''}
      ${claim}
      ${roundTable}
      ${!guessing ? `<div class="card"><div class="side-h">Голосование <span class="muted small">— нужны голоса всех остальных</span></div>${players}</div>` : ''}
      ${score.length && score.some(([, n]) => n) ? `<div class="card"><div class="side-h">Общий счёт</div>${leaderboard(score)}</div>` : ''}
    </div>`;
  }

  // ===== Кто я: сетка как в звонке, заметки, большие кнопки внизу =====
  function rWho(g) {
    const me = S.me;
    if (!g.inGame) return `<div class="narrow"><div class="stage-card"><p>Игра уже идёт.</p><button class="btn primary mega" data-act="who-add">Присоединиться со случайным персонажем</button></div></div>`;
    if (g.phase === 'write') {
      const waiting = g.pending.map(nm).join(', ');
      return `<div class="narrow"><div class="stage-card">
        ${
          g.writeFor
            ? `<div class="kicker">Загадайте персонажа</div><div class="expl">${pa(g.writeFor, 96)}<h2 class="h2">для ${nm(g.writeFor)}</h2></div>
               ${g.writtenForTarget ? `<p class="ok-text">${ic('check', 16)} Готово! Можно поменять, пока ждём остальных.</p>` : ''}
               <form data-form="who-write" class="big-form"><input class="inp big-inp" name="text" data-keep="who-write" maxlength="60" placeholder="Персонаж или известный человек" autocomplete="off" required/><button class="btn primary mega">${g.writtenForTarget ? 'Заменить' : 'Загадать'}</button></form>
               <button class="link-btn" data-act="who-random">или выбрать случайного</button>`
            : '<p>Ждём остальных…</p>'
        }
        ${waiting ? `<p class="muted small">Ещё думают: ${waiting}</p>` : ''}
      </div></div>`;
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
        return `<div class="tile ${speaking ? 'speaking' : ''} ${p.guessed ? 'done' : ''} ${p.gaveUp ? 'gaveup' : ''} ${isMe ? 'me' : ''}">
          <div class="tile-char ${p.char ? '' : 'hidden-char'}">${p.char ? esc(p.char) : `${ic('question', 18)} это вы`}</div>
          <div class="tile-ava">${pa(id, 88, 'round')}</div>
          <div class="tile-foot">
            <span class="tile-name">${speaking ? ic('mic', 14) : ''}${nm(id)}${isMe ? ' (вы)' : ''}</span>
            <span class="tile-st">${p.guessed ? `${ic('check', 13)} #${place + 1} · +${g.points[id]}` : p.gaveUp ? 'сдался' : ''}</span>
          </div>
        </div>`;
      })
      .join('');
    const notesKey = `pg_notes_${S.room.code}`;
    const actions = over
      ? ''
      : `<div class="mega-dock">
          ${g.turnPid === me ? `<button class="btn primary mega" data-act="who-next">${ic('skip', 24)} Передать ход</button>` : ''}
          ${!myState.guessed && !myState.gaveUp ? `<button class="btn success mega" data-act="who-guessed">${ic('check', 24)} Я угадал!</button><button class="btn ghost mega" data-act="who-giveup">${ic('flag', 22)} Сдаюсь</button>` : `<span class="muted">Вы уже ${myState.guessed ? 'угадали' : 'сдались'} — помогайте остальным</span>`}
        </div>`;
    return `<div class="who">
      <div class="banner">${over ? `${ic('sparkles', 18)} Все персонажи угаданы!` : `<span>${ic('mic', 16)} Спрашивает <b>${nm(g.turnPid)}</b> — вопросы «да/нет». После ответа «нет» ход переходит.</span>`}</div>
      <div class="call-grid">${tiles}</div>
      ${over ? `<div class="card"><div class="side-h">Очки <span class="muted small">— угадал +1, первый +2, второй +1</span></div>${leaderboard(Object.entries(g.points))}</div>` : ''}
      <div class="card notes-card"><div class="side-h">${ic('pencil', 16)} Мои заметки <span class="muted small">— видно только вам</span></div><textarea class="inp notes" data-keep="notes" data-notes="${notesKey}" rows="2" placeholder="Не человек, мужчина, из фильма…">${esc(LS.get(notesKey, ''))}</textarea></div>
      ${actions}
    </div>`;
  }

  // ===== Намёк понял: всё по центру, главное действие — крупно =====
  function rJust(g) {
    const head = `<div class="jo-head"><span>Раунд <b>${g.round}</b></span><span>До победы: <b>${g.target}</b> очков</span><span>Угадывает: ${who(g.guesser, 'sm')}</span></div>`;
    const board = `<div class="card"><div class="side-h">Очки <span class="muted small">— угадал +2, подсказка дошла +1, лучшая подсказка +3</span></div>${leaderboard(Object.entries(g.points), g.guesser)}</div>`;
    if (!g.inGame) return `<div class="narrow">${head}<div class="stage-card"><button class="btn primary mega" data-act="jo-add">Присоединиться</button></div>${board}</div>`;
    let body = '';
    const lastRound =
      g.lastRound && g.phase === 'clues' && Object.keys(g.lastRound.got).length
        ? `<div class="card last-round small"><b>Прошлый раунд («${esc(g.lastRound.word)}»):</b> ${Object.entries(g.lastRound.got)
            .map(([id, r]) => `${nm(id)} <b class="plus">+${r.pts}</b>`)
            .join(' · ')}</div>`
        : '';
    // Угадывающий видит подсказки без авторов — выбирает лучшую честно
    const hearted = (c) => (g.isGuesser ? g.heart != null && c.key === g.heart : c.pid === g.heart);
    const clueEl = (c, tag = 'div', extra = '') =>
      `<${tag} class="clue ${c.removed ? 'removed' : ''} ${hearted(c) ? 'hearted' : ''}" ${extra}><b>${hearted(c) ? ic('heartf', 16, 'heart') : ''}${esc(c.text)}</b>${c.pid && !g.isGuesser ? `<small>${pa(c.pid, 'xs')}${nm(c.pid)}</small>` : ''}</${tag}>`;
    const bigForm = (form, ph, btnText, keep, max) =>
      `<form data-form="${form}" class="big-form"><input class="inp big-inp" name="text" data-keep="${keep}" maxlength="${max}" placeholder="${ph}" autocomplete="off" ${form === 'jo-clue' ? 'required' : ''}/><button class="btn primary mega">${btnText}</button></form>`;
    if (g.phase === 'clues') {
      const total = g.helpers.length;
      const done = g.submitted.length;
      body = g.isGuesser
        ? `<div class="stage-card"><div class="kicker">Вы угадываете</div><div class="big-ic">${ic('eyeoff', 48)}</div><h2 class="h2">Не подглядывайте</h2><p class="muted">Подсказки пишут: ${done}/${total}</p></div>`
        : `<div class="stage-card"><div class="kicker">Загаданное слово</div><div class="mega-word">${esc(g.word)}</div>
            ${bigForm('jo-clue', 'Одно слово-подсказка', g.myClue ? 'Заменить' : `${ic('send', 22)} Отправить`, 'jo-clue', 30)}
            ${g.myClue ? `<p class="ok-text">${ic('check', 16)} Ваша подсказка: <b>${esc(g.myClue)}</b></p>` : ''}
            <p class="muted small">Готово: ${done}/${total}</p></div>`;
    } else if (g.phase === 'filter') {
      body = g.isGuesser
        ? `<div class="stage-card"><div class="big-ic">${ic('eyeoff', 48)}</div><h2 class="h2">Подсказчики убирают совпадения…</h2><p class="muted">Ещё чуть-чуть</p></div>`
        : `<div class="stage-card"><div class="kicker">Слово: ${esc(g.word)}</div><p>Вычеркните одинаковые и однокоренные подсказки (совпадения уже отмечены). Нажмите на подсказку, чтобы переключить.</p>
            <div class="clues">${g.clues.map((c) => clueEl(c, 'button', `data-act="jo-toggle" data-pid="${c.pid}"`)).join('')}</div>
            <button class="btn primary mega" data-act="jo-filterdone">Показать угадывающему ${ic('play', 22)}</button></div>`;
    } else if (g.phase === 'guess') {
      const cl = g.clues.map((c) => clueEl(c)).join('');
      body = g.isGuesser
        ? `<div class="stage-card"><div class="kicker">Подсказки</div><div class="clues big">${cl || `<p class="muted">${ic('alert', 16)} Все подсказки сгорели</p>`}</div>
            ${bigForm('jo-guess', 'Ваш ответ', 'Ответить', 'jo-guess', 40)}
            <button class="link-btn" data-act="jo-pass">пропустить слово</button></div>`
        : `<div class="stage-card"><div class="kicker">Слово: ${esc(g.word)}</div><div class="clues">${cl}</div><p class="muted">${nm(g.guesser)} думает…</p></div>`;
    } else if (g.phase === 'result') {
      const res = g.correct === null ? `${ic('skip', 22)} Пропуск — очков нет` : g.accepted ? `${ic('check', 22)} Засчитано — все подсказчики согласны` : g.correct ? `${ic('check', 22)} Угадано!` : `${ic('x', 22)} Не совпало`;
      // Неточный ответ: подсказчики голосуют «засчитать», нужен голос каждого
      const voting = g.guess && !g.correct;
      const me = S.me;
      const iAccept = g.accept.includes(me);
      const acceptBox = voting
        ? `<div class="jo-accept">
            <p><b>Почти угадал?</b> <span class="muted">Синоним, опечатка или другая форма слова — ответ засчитается, если «за» все подсказчики.</span></p>
            <div class="ja-row">
              <span class="ja-votes">${g.helpers.map((id) => `<span class="ava-wrap ${g.accept.includes(id) ? 'is-ready' : ''}" title="${nm(id)}${g.accept.includes(id) ? ' — за' : ''}">${pa(id, 'sm', 'round')}${g.accept.includes(id) ? `<span class="rd">${ic('check', 11)}</span>` : ''}</span>`).join('')}<span class="muted small">${g.accept.length}/${g.helpers.length}</span></span>
              ${!g.isGuesser && g.helpers.includes(me) ? `<button class="btn ${iAccept ? 'ja-on' : 'success'} big-w" data-act="jo-override">${ic('check', 18)} ${iAccept ? 'Вы за — отменить' : 'Засчитать'}</button>` : g.isGuesser ? '<span class="muted">Подсказчики решают…</span>' : ''}
            </div>
          </div>`
        : '';
      const live = g.clues.filter((c) => !c.removed);
      let hearts = '';
      if (g.correct) {
        hearts = g.isGuesser
          ? `<p><b>Какая подсказка помогла больше всего?</b> <span class="muted small">Авторы скрыты — выбирайте честно. Автору +3</span></p><div class="clues big">${live.map((c) => clueEl(c, 'button', `data-act="jo-heart" data-key="${c.key}"`)).join('')}</div>`
          : `<div class="clues">${live.map((c) => clueEl(c)).join('')}</div>`;
      }
      const waitHeart = g.correct && g.heart == null && !g.isGuesser && !isHost();
      body = `<div class="stage-card"><div class="kicker">Было слово</div><div class="mega-word">${esc(g.word)}</div>
        <p>Ответ: <b>${esc(g.guess || '—')}</b></p><h2 class="h2 res">${res}</h2>
        ${acceptBox}${hearts}
        <div class="row c">${waitHeart ? `<span class="muted">Ждём отметку от ${nm(g.guesser)}</span>` : voting && g.isGuesser && !isHost() ? '' : `<button class="btn ${voting ? 'ghost' : 'primary mega'}" data-act="jo-next">${voting ? 'Не засчитывать, дальше' : g.isGuesser && g.correct && g.heart == null ? 'Дальше без отметки' : 'Дальше'} ${ic('play', 20)}</button>`}</div></div>`;
    } else if (g.phase === 'over') {
      body = `<div class="stage-card"><div class="big-ic">${ic('bulb', 56)}</div><h2 class="h2">Победа: ${g.winners.map(nm).join(', ')}!</h2>
        ${canRestart() ? `<button class="btn primary big-w" data-act="jo-restart">${ic('reset', 18)} Ещё раз</button>` : ''}</div>`;
    }
    const hist = g.history.length
      ? `<details class="card log"><summary>${ic('list', 16)} Прошлые слова</summary>${g.history
          .slice()
          .reverse()
          .map((h) => `<div class="log-i">${ic(h.correct ? 'check' : h.correct === null ? 'skip' : 'x', 14)} <b>${esc(h.word)}</b> — ${nm(h.guesser)}${h.guess ? `: «${esc(h.guess)}»` : ''}${h.heart ? ` · ${ic('heartf', 12, 'heart')} ${nm(h.heart)}` : ''}</div>`)
          .join('')}</details>`
      : '';
    return `<div class="narrow justone">${head}${lastRound}${body}${board}${hist}</div>`;
  }

  // ---------- обработчики ----------
  const setAv = (scope, fn) => {
    if (scope === 'room') ui.avEdit = fn({ ...ui.avEdit });
    else {
      ui.avatar = fn({ ...ui.avatar });
      LS.set('pg_avatar', JSON.stringify(ui.avatar));
    }
    render();
  };
  const ACTIONS = {
    // аватар
    'av-set': (d) => setAv(d.scope, (a) => ({ ...a, [d.k]: Number(d.v) })),
    'av-random': (d) => setAv(d.scope, () => PixelAvatar.random()),
    'av-open': () => {
      ui.menu = null;
      ui.avEdit = { ...(player(S.me)?.avatar || ui.avatar) };
      render();
    },
    'av-cancel': () => {
      ui.avEdit = null;
      render();
    },
    'av-save': async () => {
      const a = ui.avEdit;
      const r = await emit('setAvatar', { avatar: a });
      if (!r.error) {
        ui.avatar = a;
        LS.set('pg_avatar', JSON.stringify(a));
        ui.avEdit = null;
        render();
      }
    },
    // вход
    'home-pick': (d) => {
      ui.homeSel = d.id;
      render();
      if (d.id === 'new') $app.querySelector('[name=name]')?.focus();
    },
    'home-back': () => {
      ui.homeStep = 'who';
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
      ui.menu = null;
      render();
    },
    chat: () => {
      ui.chatOpen = !ui.chatOpen;
      render();
      if (ui.chatOpen) $app.querySelector('[data-keep="chat"]')?.focus();
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
    'cn-new': () => confirm('Разложить новую доску?') && act('newBoard'),
    'cn-shuffle': () => confirm('Перемешать команды и назначить капитанов случайно?') && act('shuffleTeams'),
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
      render();
    },
    'cn-strike': (d) => act('strike', { clue: Number(d.clue), k: Number(d.k) }),
    'cn-edit': () => {
      const c = S.game.clue;
      ui.cnEdit = true;
      ui.cnSlots = c.slots.map((x) => ({ id: slotId(), v: fmtV(x.v) }));
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
    'al-skipturn': () => act('skipTurn'),
    'al-restart': () => confirm('Начать заново? Счёт обнулится.') && act('restart'),
    // шпион
    'spy-hide': () => {
      ui.hideCard = !ui.hideCard;
      render();
    },
    'spy-vote': (d) => act('vote', { target: d.pid }),
    'spy-claim': () => confirm('У вас будет минута, чтобы назвать локацию вслух. Начинаем?') && act('claim'),
    'spy-judge': (d) => act('judge', { ok: d.ok === '1' }),
    'spy-reveal': () => act('reveal'),
    'spy-next': () => act('next'),
    // кто я
    'who-random': () => act('randomFor'),
    'who-force': () => act('forceStart'),
    'who-next': () => act('next'),
    'who-guessed': () => confirm('Вы назвали персонажа и вам подтвердили?') && act('guessed'),
    'who-giveup': () => confirm('Сдаться и узнать персонажа?') && act('giveUp'),
    'who-add': () => act('addMe'),
    // намёк понял
    'jo-toggle': (d) => act('toggle', { pid: d.pid }),
    'jo-filterdone': () => act('filterDone'),
    'jo-pass': () => act('guess', { text: '' }),
    'jo-override': () => act('override'),
    'jo-heart': (d) => act('heart', { key: Number(d.key) }),
    'jo-next': () => act('next'),
    'jo-force': () => act('forceFilter'),
    'jo-restart': () => act('restart'),
    'jo-add': () => act('addMe'),
    // марафон
    'tour-next': () => emit('tourNext'),
    'tour-end': () => emit('tourEnd'),
    'tour-table': () => {
      ui.showTable = !ui.showTable;
      render();
    },
    mode: (d) => {
      ui.mode = d.m;
      render();
    },
    'm-rounds': (d) => {
      ui.mRounds[d.id] = Math.min(10, Math.max(1, (ui.mRounds[d.id] || 1) + Number(d.d)));
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
          prompt('Скопируйте ссылку:', link);
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
        if (confirm('Уйти в лобби? Игра встанет на паузу — к ней можно будет вернуться.')) emit('stopGame');
        break;
      case 'pick':
        ui.selected = d.id;
        emit('selectGame', { type: d.id });
        render();
        break;
      case 'kick':
        ui.menu = null;
        if (confirm('Выгнать игрока?')) emit('kick', { target: d.pid });
        break;
      case 'makeHost':
        ui.menu = null;
        if (confirm('Передать права хоста?')) emit('makeHost', { target: d.pid });
        break;
      case 'rename': {
        ui.menu = null;
        const n = prompt('Новое имя:', LS.get('pg_name', ''));
        if (n && n.trim()) {
          LS.set('pg_name', n.trim());
          emit('rename', { name: n.trim() });
        }
        break;
      }
      case 'leave':
        if (confirm('Выйти из комнаты?')) {
          await emit('leaveRoom');
          S = null;
          history.replaceState(null, '', '/');
          render();
        }
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
    if (kind === 'who') {
      const sel = ui.homeSel;
      if (!sel) return toast('Выберите себя');
      if (sel === 'new') {
        const name = String(fd.get('name') || '').trim();
        if (!name) return toast('Введите имя');
        LS.set('pg_profile', '');
        LS.set('pg_name', name);
      } else LS.set('pg_profile', sel);
      LS.set('pg_avatar', JSON.stringify(ui.avatar));
      ui.homeStep = 'avatar';
      render();
      window.scrollTo({ top: 0 });
    } else if (kind === 'enter') {
      LS.set('pg_avatar', JSON.stringify(ui.avatar));
      const id = identity();
      const go = e.submitter?.value || 'create';
      if (go === 'join') {
        const code = (codeFromUrl() && !fd.get('code') ? codeFromUrl() : String(fd.get('code') || '')).toUpperCase();
        if (code.length !== 4) return toast('Код комнаты — 4 буквы');
        await emit('joinRoom', { token, code, ...id });
      } else await emit('createRoom', { token, ...id });
    } else if (kind === 'chat') {
      const text = String(fd.get('text') || '').trim();
      if (text) {
        clear();
        emit('chat', { text });
      }
    } else if (kind === 'start') {
      if (S.room.suspended && !confirm('Игра на паузе будет удалена. Начать новую?')) return;
      const r = await emit('startGame', { settings: collectSettings(fd, gameMeta(ui.selected)) });
      if (!r.error) f.querySelectorAll('textarea').forEach((t) => (t.value = ''));
    } else if (kind === 'tour') {
      if (S.room.suspended && !confirm('Игра на паузе будет удалена. Начать марафон?')) return;
      const plan = ui.mOrder.filter((id) => ui.mOn[id]).map((id) => ({ type: id, rounds: ui.mRounds[id] || 1, settings: collectSettings(fd, gameMeta(id), id + '__') }));
      const r = await emit('startTour', { plan });
      if (!r.error) ui.showTable = false;
    } else if (kind === 'clue') {
      const vals = (ui.cnSlots || [{ v: '1' }]).map((x) => String(x.v).trim());
      const bad = vals.find((v) => !validStrength(v));
      if (bad !== undefined) return toast(`Сила «${bad || 'пусто'}» — число больше 0 и не больше 1, до двух знаков: 1, 0.73, 0.5`);
      const edit = f.dataset.mode === 'edit';
      const r = await act(edit ? 'editClue' : 'clue', { word: fd.get('word'), slots: vals });
      if (!r.error) {
        clear();
        ui.cnSlots = null;
        ui.cnEdit = false;
        render();
      }
    } else if (kind === 'who-write') {
      const r = await act('write', { text: fd.get('text') });
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (ui.menu || ui.avEdit || ui.showRules)) {
      ui.menu = null;
      ui.avEdit = null;
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
        x.v = e.target.dataset.kind === 'range' ? fmtV(e.target.value) : e.target.value;
        const twin = $app.querySelector(`[data-slot="${x.id}"][data-kind="${e.target.dataset.kind === 'range' ? 'num' : 'range'}"]`);
        if (twin && e.target.dataset.kind === 'range') twin.value = x.v;
        if (twin && e.target.dataset.kind === 'num' && validStrength(x.v)) twin.value = parseFloat(x.v.replace(',', '.'));
        e.target.closest('.slot')?.classList.toggle('bad', !validStrength(x.v));
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
