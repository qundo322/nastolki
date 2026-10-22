// node demo/build.js → demo/party-games-demo.html (один файл, без сервера)
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'entry.js')],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2019',
  alias: { crypto: path.join(__dirname, 'crypto-shim.js') },
}).outputFiles[0].text;
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const app = ['public/js/icons.js', 'public/js/sound.js', 'public/js/rules.js', 'public/app.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
const demoCss = `
#demo-bar{position:fixed;left:0;right:0;bottom:0;z-index:90;background:var(--surface);border-top:2px solid var(--accent);box-shadow:0 -6px 20px rgba(0,0,0,.18);padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
.db-row{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none}
.db-l{font-size:12px;font-weight:800;color:var(--accent-text);white-space:nowrap;text-transform:uppercase;letter-spacing:.05em}
.db-p{border:1px solid var(--line);background:var(--surface-2);color:var(--text);border-radius:99px;padding:6px 12px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap}
.db-p.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.db-p.add,.db-p.exit{background:transparent;border-style:dashed}
.db-hint{font-size:12px;color:var(--muted);margin-top:5px;min-height:15px}
.db-row .db-hint{margin:0}
body{padding-bottom:84px}
.ctlbar{bottom:94px} .chat-dock{bottom:94px} #lofi{bottom:94px} body.has-ctl #lofi{bottom:170px} #toasts{bottom:calc(var(--ctl-h) + 110px)}
.stage{padding-bottom:calc(var(--ctl-h) + 180px)}
@media (max-width:700px){.ctlbar{bottom:90px}.chat-dock{bottom:90px}}`;
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Экранки — демо</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto+Condensed:wght@600;700&display=swap" rel="stylesheet"/>
<script>(function(){var t=null;try{t=localStorage.getItem("pg_theme")}catch(e){}if(t!=="light"&&t!=="dark"&&t!=="oled")t=window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-theme",t)})()</script>
<style>${css}\n${demoCss}</style></head>
<body><div id="app"></div><div id="toasts"></div>
<script>${bundle}</script>
<script>${app.replace(/<\/script/g, '<\\/script')}</script>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'party-games-demo.html'), html);
console.log('ok', (html.length / 1024).toFixed(0) + ' KB');
