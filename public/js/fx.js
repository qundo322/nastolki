/* Эффекты интерфейса:
   1) магнитные кнопки — кнопка слегка тянется к курсору, текст/иконка внутри — чуть дальше (параллакс);
   2) «магические» карточки — лёгкий 3D-наклон за курсором, блик-прожектор и светящийся край;
   3) голографические волны — фон на WebGL для входа и лобби (цвета под тему).
   Всё работает через делегирование на document, поэтому переживает перерисовки innerHTML.
   Только мышь (на телефонах эффекты не нужны) и только если не включено «меньше анимации». */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- 1. Магнитные кнопки ----------
  const MAG = '.btn:not([disabled]), .chat-fab, .ctl-fab, .icon-b:not([disabled]), .exit-btn, .code-btn';
  const MAG_K = 0.24; // сила притяжения (доля расстояния до центра)
  const MAG_MAX = 7; // не дальше, px
  let magEl = null;
  function magRelease(el) {
    el.classList.remove('mag');
    el.style.translate = '';
    el.style.removeProperty('--mag-x');
    el.style.removeProperty('--mag-y');
  }
  // ---------- 2. Магические карточки ----------
  const MC = '.cn-card:not(.rev):not(.blank), .gcard:not([disabled]), button.jc, .rw, .m-pre, .mj-g.host, .mj-s.host, .spy-card';
  const MC_TILT = 6; // градусов — вдвое мягче оригинала
  let mcEl = null;
  let mcPress = false;
  function mcApply(el, px, py) {
    const rx = (0.5 - py) * 2 * MC_TILT;
    const ry = (px - 0.5) * 2 * MC_TILT;
    el.style.transform = `perspective(720px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-2px) scale(${mcPress ? 0.98 : 1.015})`;
    el.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
    el.style.setProperty('--my', (py * 100).toFixed(1) + '%');
  }
  function mcRelease(el) {
    el.classList.remove('mc-on');
    el.style.transform = '';
  }

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reduce.matches) return;
    const t = e.target.closest ? e.target : null;
    // магнит
    const m = t && t.closest(MAG);
    if (magEl && magEl !== m) magRelease(magEl);
    magEl = m;
    if (m && !m.closest('.crop-box')) {
      const r = m.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      // Чем меньше кнопка, тем слабее магнит — иначе в маленькие трудно попасть.
      // Сила и предел растут с высотой кнопки: 28px → ~1.5px, 44px → ~4px, 56px+ → 7px.
      const size = Math.min(r.height, r.width);
      const f = clamp((size - 22) / 34, 0.12, 1);
      const max = MAG_MAX * f;
      const kx = MAG_K * f * Math.min(1, 160 / r.width); // широкие — слабее по горизонтали
      const tx = clamp(dx * kx, -max, max);
      const ty = clamp(dy * MAG_K * f, -max * 0.7, max * 0.7);
      m.classList.add('mag');
      m.style.translate = `${tx.toFixed(2)}px ${ty.toFixed(2)}px`;
      m.style.setProperty('--mag-x', (tx * 0.45).toFixed(2) + 'px');
      m.style.setProperty('--mag-y', (ty * 0.45).toFixed(2) + 'px');
    }
    // карточка
    const c = t && t.closest(MC);
    if (mcEl && mcEl !== c) mcRelease(mcEl);
    mcEl = c;
    if (c) {
      const r = c.getBoundingClientRect();
      c.classList.add('mc-on');
      mcApply(c, clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || !mcEl) return;
    mcPress = true;
    const r = mcEl.getBoundingClientRect();
    mcApply(mcEl, clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  });
  document.addEventListener('pointerup', () => (mcPress = false));
  document.addEventListener('mouseleave', () => {
    if (magEl) magRelease(magEl);
    if (mcEl) mcRelease(mcEl);
    magEl = mcEl = null;
  });

  // ---------- 3. Голографические волны (WebGL) ----------
  // Цвета под тему: фон, три цвета переливов, сила
  const PAL = {
    dark: { bg: '#0e0d13', a: '#8b5cff', b: '#ff6ec7', c: '#4f7dff', k: 1.15, hl: 0.08 },
    oled: { bg: '#000000', a: '#7a4cf5', b: '#e85fb8', c: '#3f68e8', k: 0.7, hl: 0.05 },
    light: { bg: '#f5f5f7', a: '#b79bff', b: '#ff9fd6', c: '#9db4ff', k: 0.8, hl: 0.4 },
  };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FS = `precision mediump float;
uniform vec2 R;uniform float T;uniform vec2 M;uniform vec3 C0,C1,C2,C3;uniform float K,HL,LIGHT;
float h21(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
vec3 irid(float h){
  float a=.5+.5*sin(6.2832*h), b=.5+.5*sin(6.2832*h+2.1), c=.5+.5*sin(6.2832*h+4.2);
  vec3 col=mix(mix(C1,C2,a),C3,b*b*.5);
  return mix(col,vec3(1.,.36,.66),c*c*c*.42); // розовый перелив — как у голограммы
}
void main(){
  vec2 uv=gl_FragCoord.xy/R; float asp=R.x/R.y;
  vec2 q=vec2(uv.x*asp,uv.y);
  vec3 col=C0;
  float t=T*.22;
  for(int i=0;i<5;i++){
    float fi=float(i);
    float x=q.x;
    // мышь мягко «поднимает» волны рядом с собой
    float pull=(M.y-.5)*.22*exp(-pow((uv.x-M.x)*2.4,2.));
    float y=.5+.17*sin(x*1.35+t*1.1+fi*1.27)+.07*sin(x*2.9-t*1.5+fi*2.3)+.03*sin(x*6.1+t*2.+fi)+(fi-2.)*.085+pull;
    float w=.055+.03*sin(t*1.3+fi*1.7+x*.7);
    float d=(uv.y-y)/w;
    float band=exp(-d*d*.9);
    float core=exp(-d*d*6.);
    float h=x*.42+fi*.19+t*.35+d*.12+(M.x-.5)*.15;
    vec3 c=irid(h);
    float a=band*(.46-fi*.05)*K;
    col=mix(col,c,clamp(a,0.,1.));
    // металлический блик по гребню
    col+=vec3(1.)*core*HL*K*(.55+.45*sin(x*3.+t*3.+fi));
  }
  // виньетка — края темнее (в светлой теме — светлее)
  float v=smoothstep(1.25,.25,length((uv-.5)*vec2(1.15,1.)));
  col=mix(C0,col,mix(.35,1.,v));
  col+=(h21(gl_FragCoord.xy+T)-.5)/255.*2.; // дизеринг против ступенек
  gl_FragColor=vec4(col,1.);
}`;
  let gl = null;
  let prog = null;
  let U = {};
  let canvas = null;
  let raf = 0;
  let on = false;
  let pal = PAL.dark;
  let last = 0;
  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  const t0 = performance.now();
  function init() {
    if (canvas) return !!gl;
    canvas = document.createElement('canvas');
    canvas.className = 'holo-bg';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      gl.useProgram(prog);
    } catch (err) {
      console.warn('holo', err);
      gl = null;
      return false;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['R', 'T', 'M', 'C0', 'C1', 'C2', 'C3', 'K', 'HL', 'LIGHT']) U[n] = gl.getUniformLocation(prog, n);
    addEventListener('resize', size);
    addEventListener('pointermove', (e) => {
      mouse.tx = e.clientX / innerWidth;
      mouse.ty = 1 - e.clientY / innerHeight;
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : on && loop()));
    size();
    return true;
  }
  function size() {
    if (!canvas) return;
    // волны мягкие — рисуем в половинном разрешении, браузер сам растянет
    const s = Math.min(1, 900 / Math.max(innerWidth, innerHeight)) * 0.75;
    canvas.width = Math.max(2, Math.round(innerWidth * s));
    canvas.height = Math.max(2, Math.round(innerHeight * s));
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    if (on) frame(performance.now(), true);
  }
  function frame(now, force) {
    if (!gl) return;
    if (!force && now - last < 33) return; // ~30 кадров/с хватает
    last = now;
    mouse.x += (mouse.tx - mouse.x) * 0.05;
    mouse.y += (mouse.ty - mouse.y) * 0.05;
    gl.uniform2f(U.R, canvas.width, canvas.height);
    gl.uniform1f(U.T, reduce.matches ? 8 : (now - t0) / 1000);
    gl.uniform2f(U.M, mouse.x, mouse.y);
    gl.uniform3fv(U.C0, hex(pal.bg));
    gl.uniform3fv(U.C1, hex(pal.a));
    gl.uniform3fv(U.C2, hex(pal.b));
    gl.uniform3fv(U.C3, hex(pal.c));
    gl.uniform1f(U.K, pal.k);
    gl.uniform1f(U.HL, pal.hl);
    gl.uniform1f(U.LIGHT, pal === PAL.light ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function loop() {
    cancelAnimationFrame(raf);
    if (reduce.matches) return frame(performance.now(), true);
    const step = (now) => {
      frame(now);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  // Включить/выключить фон и обновить цвета темы
  function setWave(want, theme) {
    pal = PAL[theme] || PAL.dark;
    if (want && !init()) return;
    if (!canvas) return;
    document.documentElement.classList.toggle('holo', !!want && !!gl);
    if (want === on) {
      if (on) frame(performance.now(), true);
      return;
    }
    on = !!want;
    if (on) {
      canvas.classList.add('on');
      frame(performance.now(), true);
      loop();
    } else {
      canvas.classList.remove('on');
      stop();
    }
  }
  window.FX = { setWave };
})();
