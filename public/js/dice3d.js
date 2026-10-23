// Настоящие 3D-кубики для «Костей 1000»: цельное тело со скруглёнными рёбрами и лунками-очками
// считается в шейдере (ray marching по SDF), поэтому нет граней-«склеек», зазоров и лесенки.
// Один общий WebGL2-контекст рисует все кубики и копирует картинку в их <canvas class="dgl">.
// Анимация зависит только от времени (data-t0), поэтому переживает перерисовку интерфейса.
(function () {
  const FRAME = 0.9; // половина кадра в единицах кубика (кубик = 1): запас под вращение
  // Грани в теле кубика: +z=1, -z=6, +y=2, -y=5, +x=3, -x=4 (противоположные в сумме 7)
  const R = (a, b, c, d, e, f, g, h, i) => [a, b, c, d, e, f, g, h, i]; // по столбцам
  const FINAL = {
    1: R(1, 0, 0, 0, 1, 0, 0, 0, 1),
    6: R(-1, 0, 0, 0, 1, 0, 0, 0, -1), // 180° вокруг y
    2: R(1, 0, 0, 0, 0, 1, 0, -1, 0), // y → z
    5: R(1, 0, 0, 0, 0, -1, 0, 1, 0), // -y → z
    3: R(0, 0, 1, 0, 1, 0, -1, 0, 0), // x → z
    4: R(0, 0, -1, 0, 1, 0, 1, 0, 0), // -x → z
  };
  const mul = (a, b) => {
    const o = new Array(9);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
    return o;
  };
  const axisAngle = (x, y, z, t) => {
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const c = Math.cos(t), s = Math.sin(t), k = 1 - c;
    return [c + x * x * k, y * x * k + z * s, z * x * k - y * s, x * y * k - z * s, c + y * y * k, z * y * k + x * s, x * z * k + y * s, y * z * k - x * s, c + z * z * k];
  };
  const hash = (n) => {
    let x = (n * 2654435761) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 2246822519) >>> 0;
    x ^= x >>> 13;
    return x / 4294967295;
  };

  const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p; gl_Position = vec4(p, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform mat3 uR; uniform vec2 uRes; uniform float uFrame;
const float RAD = 0.13;      // радиус скругления рёбер
const float G = 0.255;       // шаг сетки очков
const float PR = 0.098;      // радиус сферы-лунки
const float PO = 0.535;      // центр сферы чуть над гранью → лунка глубиной ~0.06
// маски очков по сетке 3×3 (бит k = клетка k, слева-направо сверху-вниз)
const int M[7] = int[7](0, 16, 68, 84, 325, 341, 365);
float box(vec3 p){ vec3 q = abs(p) - vec3(0.5 - RAD); return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.) - RAD; }
// ближайшая лунка на «своей» грани; f — номер грани
float pip(vec3 p, out int f){
  vec3 a = abs(p); vec3 n; vec2 w;
  if (a.z >= a.x && a.z >= a.y) { f = p.z > 0. ? 1 : 6; n = vec3(0., 0., sign(p.z)); w = vec2(p.x * sign(p.z), p.y); }
  else if (a.y >= a.x) { f = p.y > 0. ? 2 : 5; n = vec3(0., sign(p.y), 0.); w = vec2(p.x, -p.z * sign(p.y)); }
  else { f = p.x > 0. ? 3 : 4; n = vec3(sign(p.x), 0., 0.); w = vec2(-p.z * sign(p.x), p.y); }
  int m = M[f];
  float d = 1e3;
  for (int k = 0; k < 9; k++) {
    if (((m >> k) & 1) == 0) continue;
    vec2 c = vec2(float(k % 3 - 1), float(1 - k / 3)) * G;
    vec2 e = w - c;
    d = min(d, sqrt(dot(e, e) + pow(dot(p, n) - PO, 2.)) - PR);
  }
  return d;
}
float map(vec3 p){ int f; return max(box(p), -pip(p, f)); }
vec3 nrm(vec3 p){ vec2 e = vec2(0.0007, 0.); return normalize(vec3(map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx))); }
vec4 shade(vec2 s){
  mat3 T = transpose(uR);
  vec3 ro = vec3(0., 0., 6.), rd = normalize(vec3(s * uFrame, -6.));
  vec3 o3 = T * ro, d3 = T * rd;
  float b = dot(o3, d3), c = dot(o3, o3) - 0.76; float h = b * b - c;
  if (h < 0.) return vec4(0.);
  float t = -b - sqrt(h), tEnd = -b + sqrt(h);
  for (int i = 0; i < 90; i++) {
    vec3 p = o3 + d3 * t; float d = map(p);
    if (d < 0.0004) {
      vec3 n = uR * nrm(p);
      int f; float pd = pip(p, f);
      bool isPip = pd < 0.003;
      vec3 base = vec3(0.965, 0.945, 0.9);
      if (isPip) base = (f == 1 || f == 4) ? vec3(0.78, 0.07, 0.08) : vec3(0.09, 0.09, 0.1);
      vec3 L = normalize(vec3(-0.45, 0.65, 0.75));
      vec3 V = -rd, H = normalize(L + V);
      float dif = max(dot(n, L), 0.) * 0.7 + 0.42;
      float spec = pow(max(dot(n, H), 0.), isPip ? 60. : 38.) * (isPip ? 0.45 : 0.32);
      float fr = pow(1. - max(dot(n, V), 0.), 3.);
      // мягкое затенение внутри лунок и на рёбрах
      float ao = clamp(map(p + (T * n) * 0.05) / 0.05, 0., 1.);
      ao = 0.62 + 0.38 * ao;
      vec3 col = base * dif * ao + vec3(spec) + fr * vec3(0.10, 0.09, 0.07);
      col -= (1. - max(dot(n, vec3(0., 0., 1.)), 0.)) * 0.06 * vec3(0.4, 0.35, 0.3);
      return vec4(col, 1.);
    }
    t += d;
    if (t > tEnd) break;
  }
  return vec4(0.);
}
void main(){
  vec2 px = 1. / uRes; vec4 acc = vec4(0.);
  // 4 сэмпла на пиксель (повёрнутая решётка) — гладкий край без лесенки
  acc += shade(uv + vec2( 0.125,  0.375) * px * 2.);
  acc += shade(uv + vec2(-0.375,  0.125) * px * 2.);
  acc += shade(uv + vec2( 0.375, -0.125) * px * 2.);
  acc += shade(uv + vec2(-0.125, -0.375) * px * 2.);
  acc *= 0.25;
  o = acc; // уже с premultiplied alpha
}`;

  let gl = null, glc = null, prog = null, loc = {}, failed = false;
  function init() {
    if (gl || failed) return !!gl;
    try {
      glc = document.createElement('canvas');
      glc.width = glc.height = 512;
      gl = glc.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw 0;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const pl = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(pl);
      gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
      loc = { R: gl.getUniformLocation(prog, 'uR'), res: gl.getUniformLocation(prog, 'uRes'), frame: gl.getUniformLocation(prog, 'uFrame') };
      glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; failed = true; document.querySelectorAll('canvas.dgl').forEach((c) => (c._k = '')); });
      return true;
    } catch (e) {
      console.warn('[dice3d] WebGL2 недоступен, рисую плоские кубики', e && e.message);
      gl = null;
      failed = true;
      return false;
    }
  }

  // Запасной вариант без WebGL: аккуратный плоский кубик гранью к нам
  const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  function flat(ctx, w, v) {
    const s = w / (2 * FRAME), x0 = (w - s) / 2, r = s * 0.16;
    ctx.clearRect(0, 0, w, w);
    const g = ctx.createLinearGradient(x0, x0, x0 + s, x0 + s);
    g.addColorStop(0, '#fffdf7');
    g.addColorStop(1, '#e4ddcf');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x0, x0, s, s, r) : ctx.rect(x0, x0, s, s);
    ctx.fill();
    ctx.fillStyle = v === 1 || v === 4 ? '#c21115' : '#17171a';
    for (const k of PIPS[v]) {
      const cx = x0 + s / 2 + ((k - 1) % 3 - 1) * s * 0.255, cy = x0 + s / 2 + (Math.floor((k - 1) / 3) - 1) * s * 0.255;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.095, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const ease = (t) => 1 - Math.pow(1 - t, 3.2);
  function draw(cv, t) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(16, Math.min(512, Math.round(cv.clientWidth * dpr)));
    if (!cv.clientWidth) return;
    const v = +cv.dataset.v || 1;
    const t0 = +cv.dataset.t0 || 0, dur = +cv.dataset.dur || 0;
    const calm = document.documentElement.classList.contains('v-calm');
    let k = dur && !calm ? (t - t0) / dur : 1;
    const moving = k < 1;
    k = Math.max(0, Math.min(1, k));
    const key = `${v}|${w}|${moving ? k.toFixed(4) : 'rest'}`;
    if (cv._k === key) return;
    cv._k = key;
    if (cv.width !== w) cv.width = cv.height = w;
    const ctx = cv.getContext('2d');
    if (!init()) return flat(ctx, w, v);
    let M = FINAL[v];
    if (k < 1) {
      const seed = +cv.dataset.seed || 1;
      const ax = [hash(seed) - 0.5, hash(seed + 1) - 0.5, hash(seed + 2) - 0.5];
      ax[0] += ax[0] > 0 ? 0.4 : -0.4; // вращение «через себя», а не волчком
      const turns = Math.PI * 2 * (2 + hash(seed + 3) * 1.5);
      M = mul(FINAL[v], axisAngle(ax[0], ax[1], ax[2], turns * (1 - ease(k))));
    }
    gl.viewport(0, 0, w, w);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniformMatrix3fv(loc.R, false, new Float32Array(M));
    gl.uniform2f(loc.res, w, w);
    gl.uniform1f(loc.frame, FRAME);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ctx.clearRect(0, 0, w, w);
    ctx.drawImage(glc, 0, glc.height - w, w, w, 0, 0, w, w);
  }

  function loop() {
    const t = Date.now();
    const list = document.querySelectorAll('canvas.dgl');
    for (const cv of list) draw(cv, t);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.Dice3D = { FRAME };
})();
