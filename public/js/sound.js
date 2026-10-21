/* Звуки интерфейса: синтез через WebAudio, без файлов. Sound.play('click'), Sound.vol / Sound.setVol(0..100). */
(() => {
  let ctx = null;
  let master = null;
  let vol = 60;
  try {
    const v = localStorage.getItem('pg_sfx');
    if (v !== null) vol = Math.max(0, Math.min(100, Number(v)));
  } catch {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = (vol / 100) ** 1.6 * 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // браузер разрешает звук только после первого действия пользователя
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => ac(), { once: true, capture: true }));

  // нота: частота, длительность, тип волны, громкость, задержка, скольжение к частоте
  function tone(f, dur, { type = 'sine', gain = 0.25, delay = 0, to = null, attack = 0.005 } = {}) {
    const c = ac();
    if (!c || !vol) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function noise(dur, { gain = 0.15, delay = 0, from = 800, to = 3000, q = 1.2 } = {}) {
    const c = ac();
    if (!c || !vol) return;
    const t = c.currentTime + delay;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
  }

  const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G4: 392, E4: 329.63, C4: 261.63 };
  const SFX = {
    click: () => tone(1400, 0.035, { type: 'sine', gain: 0.08 }),
    tap: () => tone(700, 0.05, { type: 'triangle', gain: 0.12 }),
    vote: () => {
      tone(N.E5, 0.08, { type: 'triangle', gain: 0.14 });
      tone(N.A5, 0.1, { type: 'triangle', gain: 0.12, delay: 0.05 });
    },
    good: () => {
      tone(N.C5, 0.14, { gain: 0.2 });
      tone(N.E5, 0.14, { gain: 0.2, delay: 0.08 });
      tone(N.G5, 0.22, { gain: 0.2, delay: 0.16 });
    },
    bad: () => {
      tone(330, 0.18, { type: 'triangle', gain: 0.18, to: 220 });
      tone(247, 0.26, { type: 'triangle', gain: 0.14, delay: 0.12, to: 165 });
    },
    boom: () => {
      tone(140, 0.6, { type: 'sawtooth', gain: 0.18, to: 40 });
      noise(0.5, { gain: 0.25, from: 400, to: 80, q: 0.7 });
    },
    turn: () => noise(0.32, { gain: 0.12, from: 500, to: 4000 }),
    myturn: () => {
      noise(0.25, { gain: 0.08, from: 600, to: 3500 });
      tone(N.G5, 0.12, { gain: 0.15, delay: 0.12 });
      tone(N.C6, 0.2, { gain: 0.15, delay: 0.22 });
    },
    win: () => [N.C5, N.E5, N.G5, N.C6, N.E6].forEach((f, i) => tone(f, 0.22, { type: 'triangle', gain: 0.18, delay: i * 0.09 })),
    lose: () => [N.G4, N.E4, N.C4].forEach((f, i) => tone(f, 0.3, { type: 'triangle', gain: 0.16, delay: i * 0.14 })),
    ready: () => {
      tone(N.E5, 0.1, { gain: 0.16 });
      tone(N.A5, 0.16, { gain: 0.16, delay: 0.07 });
    },
    unready: () => tone(N.A5, 0.12, { gain: 0.12, to: N.E5 }),
    start: () => {
      noise(0.4, { gain: 0.1, from: 300, to: 5000 });
      [N.C5, N.G5, N.C6].forEach((f, i) => tone(f, 0.18, { gain: 0.15, delay: 0.1 + i * 0.07 }));
    },
    pop: () => tone(900, 0.07, { type: 'sine', gain: 0.14, to: 1400 }),
    error: () => {
      tone(200, 0.09, { type: 'square', gain: 0.06 });
      tone(160, 0.12, { type: 'square', gain: 0.06, delay: 0.1 });
    },
    tick: () => tone(1800, 0.03, { type: 'sine', gain: 0.1 }),
    strike: () => noise(0.12, { gain: 0.1, from: 3000, to: 1200, q: 2 }),
    open: () => tone(600, 0.08, { type: 'sine', gain: 0.08, to: 900 }),
  };

  window.Sound = {
    play(name) {
      try {
        SFX[name] && SFX[name]();
      } catch {}
    },
    get vol() {
      return vol;
    },
    setVol(v) {
      vol = Math.max(0, Math.min(100, Math.round(v)));
      try {
        localStorage.setItem('pg_sfx', String(vol));
      } catch {}
      if (master) master.gain.value = (vol / 100) ** 1.6 * 0.9;
    },
  };
})();
