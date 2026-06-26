/**
 * NeonDeck Template Hub — 12 beginner-friendly starter sandboxes.
 *
 * Each template seeds the in-browser workspace with a small, self-contained file
 * set. Where possible the `index.html` is self-rendering (inline or linked CSS /
 * JS that the live preview inlines) so "Launch Sandbox" produces an instant,
 * working preview.
 */
export interface Template {
  id: string;
  emoji: string;
  title: string;
  desc: string;
  /** File opened in the editor after launch. */
  entry: string;
  /** posix path -> file contents. */
  files: Record<string, string>;
}

const NEON_PAGE = (title: string, body: string, extraHead = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="stylesheet" href="styles.css" />
${extraHead}
</head>
<body>
${body}
</body>
</html>
`;

const NEON_CSS = `:root{--bg:#0b0f19;--pink:#ff007f;--cyan:#00f0ff;--text:#e8f0ff;}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:'Segoe UI',system-ui,sans-serif;background:radial-gradient(circle at 50% 0%,#161c2e,#070a12);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:32px;text-align:center}
h1{margin:0;font-size:34px;text-shadow:0 0 18px var(--cyan)}
.glow{color:var(--cyan)}.pink{color:var(--pink)}
button{cursor:pointer;border:1px solid var(--cyan);background:transparent;color:var(--cyan);padding:10px 18px;border-radius:10px;font-weight:700;font-size:15px;box-shadow:0 0 14px rgba(0,240,255,.35);transition:.15s}
button:hover{background:var(--cyan);color:#06121a;box-shadow:0 0 22px var(--cyan)}
.card{background:rgba(18,24,38,.7);border:1px solid #20304d;border-radius:16px;padding:24px;backdrop-filter:blur(8px);box-shadow:0 0 30px rgba(255,0,127,.12)}
`;

export const TEMPLATES: Template[] = [
  {
    id: "canvas-game",
    emoji: "🎮",
    title: "HTML5 Canvas Game Boilerplate",
    desc: "A bouncing-ball game loop on a full canvas with neon trails.",
    entry: "game.js",
    files: {
      "styles.css": NEON_CSS + "canvas{border:1px solid var(--pink);border-radius:12px;box-shadow:0 0 30px rgba(255,0,127,.4)}",
      "index.html": NEON_PAGE(
        "Canvas Game",
        `<h1>🎮 Neon <span class="pink">Bouncer</span></h1>\n<canvas id="game" width="360" height="240"></canvas>\n<p class="glow">Edit game.js to change the physics.</p>\n<script src="game.js"></script>`,
      ),
      "game.js": `const c = document.getElementById("game");
const ctx = c.getContext("2d");
let x = 60, y = 60, dx = 2.6, dy = 2.2, r = 14;
function loop() {
  ctx.fillStyle = "rgba(7,10,18,0.35)";
  ctx.fillRect(0, 0, c.width, c.height);
  x += dx; y += dy;
  if (x < r || x > c.width - r) dx = -dx;
  if (y < r || y > c.height - r) dy = -dy;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#00f0ff";
  ctx.shadowColor = "#ff007f";
  ctx.shadowBlur = 24;
  ctx.fill();
  requestAnimationFrame(loop);
}
loop();
`,
    },
  },
  {
    id: "cyber-terminal",
    emoji: "🖥️",
    title: "Cyberpunk Terminal UI Mockup",
    desc: "A fake hacker terminal that types out a boot sequence.",
    entry: "terminal.js",
    files: {
      "styles.css": NEON_CSS + "body{justify-content:flex-start;align-items:stretch}#term{font-family:'Courier New',monospace;text-align:left;color:#00ffae;white-space:pre-wrap;text-shadow:0 0 8px #00ffae}",
      "index.html": NEON_PAGE(
        "Cyber Terminal",
        `<h1 class="pink">root@neondeck:~#</h1>\n<div id="term" class="card"></div>\n<script src="terminal.js"></script>`,
      ),
      "terminal.js": `const lines = [
  "booting NeonDeck shell v2.4 ...",
  "[ ok ] mounting /dev/neon",
  "[ ok ] establishing uplink 198.51.100.7",
  "[ ok ] decrypting payload ...",
  "access GRANTED. welcome, operator.",
];
const term = document.getElementById("term");
let i = 0, j = 0;
function type() {
  if (i >= lines.length) return;
  term.textContent += lines[i][j] ?? "";
  j++;
  if (j > lines[i].length) { term.textContent += "\\n"; i++; j = 0; }
  setTimeout(type, 24);
}
type();
`,
    },
  },
  {
    id: "portfolio-space",
    emoji: "🚀",
    title: "Personal Portfolio Space Theme",
    desc: "A single-page space portfolio with a glowing hero and links.",
    entry: "index.html",
    files: {
      "styles.css": NEON_CSS + ".links{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}.avatar{width:90px;height:90px;border-radius:50%;background:conic-gradient(var(--pink),var(--cyan));box-shadow:0 0 30px var(--pink)}",
      "index.html": NEON_PAGE(
        "Portfolio",
        `<div class="avatar"></div>\n<h1>Alex <span class="glow">Nova</span></h1>\n<p class="pink">Frontend Engineer · Cosmic UIs</p>\n<div class="card"><p>I build interfaces that feel like they came from the year 3000.</p></div>\n<div class="links"><button>GitHub</button><button>Dribbble</button><button>Contact</button></div>`,
      ),
    },
  },
  {
    id: "react-matrix",
    emoji: "⚛️",
    title: "Single-Page React App Matrix",
    desc: "A CDN-loaded React counter with a falling matrix backdrop.",
    entry: "app.jsx",
    files: {
      "styles.css": NEON_CSS + "#root{z-index:1}",
      "index.html": NEON_PAGE(
        "React Matrix",
        `<div id="root"></div>`,
        `<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel" data-presets="react" src="app.jsx"></script>`,
      ),
      "app.jsx": `function App() {
  const [n, setN] = React.useState(0);
  return (
    <div className="card">
      <h1>⚛️ React <span className="glow">Matrix</span></h1>
      <p className="pink">Count: {n}</p>
      <button onClick={() => setN(n + 1)}>Increment</button>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
`,
    },
  },
  {
    id: "node-automation",
    emoji: "🛠️",
    title: "Node.js Local Automation Tool",
    desc: "A CLI script skeleton that renames files in a folder.",
    entry: "automate.js",
    files: {
      "styles.css": NEON_CSS,
      "index.html": NEON_PAGE(
        "Node Automation",
        `<h1>🛠️ Node <span class="glow">Automation</span></h1>\n<div class="card"><p>This is a Node.js project. Open <span class="pink">automate.js</span> and run it with <code>node automate.js</code> on a Pro/Max daemon.</p></div>`,
      ),
      "automate.js": `#!/usr/bin/env node
// Batch-rename every file in a folder with a numbered prefix.
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || ".";
fs.readdirSync(dir)
  .filter((f) => fs.statSync(path.join(dir, f)).isFile())
  .forEach((f, i) => {
    const next = String(i + 1).padStart(3, "0") + "_" + f;
    console.log("rename", f, "->", next);
    // fs.renameSync(path.join(dir, f), path.join(dir, next));
  });
console.log("Done. Uncomment renameSync to apply.");
`,
      "package.json": `{
  "name": "neondeck-automation",
  "version": "1.0.0",
  "bin": { "automate": "automate.js" }
}
`,
    },
  },
  {
    id: "css-neon-anim",
    emoji: "✨",
    title: "CSS Neon Animation Sandbox",
    desc: "Pure-CSS pulsing neon sign with no JavaScript.",
    entry: "styles.css",
    files: {
      "styles.css": NEON_CSS + `.sign{font-size:54px;font-weight:900;letter-spacing:4px;animation:flicker 2.4s infinite alternate}
@keyframes flicker{0%,18%,22%,25%,53%,57%,100%{text-shadow:0 0 8px var(--cyan),0 0 22px var(--cyan),0 0 40px var(--pink);opacity:1}20%,24%,55%{text-shadow:none;opacity:.55}}`,
      "index.html": NEON_PAGE(
        "Neon Animation",
        `<div class="sign glow">NEON</div>\n<p class="pink">100% CSS — no JavaScript. Tweak the keyframes in styles.css.</p>`,
      ),
    },
  },
  {
    id: "sound-board",
    emoji: "🔊",
    title: "Interactive Sound Board",
    desc: "Click pads to trigger WebAudio beeps at different pitches.",
    entry: "board.js",
    files: {
      "styles.css": NEON_CSS + ".pads{display:grid;grid-template-columns:repeat(4,72px);gap:12px}.pad{height:72px;display:flex;align-items:center;justify-content:center;border-radius:12px}",
      "index.html": NEON_PAGE(
        "Sound Board",
        `<h1>🔊 Sound <span class="glow">Board</span></h1>\n<div class="pads" id="pads"></div>\n<p class="pink">Click a pad to play a tone.</p>\n<script src="board.js"></script>`,
      ),
      "board.js": `const ac = new (window.AudioContext || window.webkitAudioContext)();
function beep(freq) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.value = freq;
  o.type = "triangle";
  o.connect(g); g.connect(ac.destination);
  g.gain.setValueAtTime(0.25, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
  o.start(); o.stop(ac.currentTime + 0.4);
}
const notes = [262, 294, 330, 349, 392, 440, 494, 523];
const wrap = document.getElementById("pads");
notes.forEach((f, i) => {
  const b = document.createElement("button");
  b.className = "pad";
  b.textContent = i + 1;
  b.onclick = () => beep(f);
  wrap.appendChild(b);
});
`,
    },
  },
  {
    id: "kanban-grid",
    emoji: "🗂️",
    title: "Simple Task KanBan Grid",
    desc: "Three-column board; add cards to To-Do and move them along.",
    entry: "kanban.js",
    files: {
      "styles.css": NEON_CSS + `body{align-items:stretch}.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;width:100%}.col{min-height:220px}.col h3{margin:0 0 10px}.item{background:rgba(0,240,255,.08);border:1px solid var(--cyan);border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:pointer}`,
      "index.html": NEON_PAGE(
        "Kanban",
        `<h1>🗂️ <span class="glow">Kanban</span> Grid</h1>\n<input id="title" placeholder="New task..." style="padding:8px;border-radius:8px;border:1px solid #2a3b5c;background:#0d1322;color:#fff" />\n<button onclick="addCard()">Add</button>\n<div class="cols">\n<div class="col card"><h3 class="pink">To-Do</h3><div id="todo"></div></div>\n<div class="col card"><h3 class="glow">Doing</h3><div id="doing"></div></div>\n<div class="col card"><h3 style="color:#00e5a0">Done</h3><div id="done"></div></div>\n</div>\n<script src="kanban.js"></script>`,
      ),
      "kanban.js": `const cols = ["todo", "doing", "done"];
function addCard() {
  const input = document.getElementById("title");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  place(text, 0);
}
function place(text, col) {
  const el = document.createElement("div");
  el.className = "item";
  el.textContent = text;
  el.onclick = () => { el.remove(); if (col < 2) place(text, col + 1); };
  document.getElementById(cols[col]).appendChild(el);
}
place("Click a card to advance it →", 0);
`,
    },
  },
  {
    id: "markdown-engine",
    emoji: "📝",
    title: "Markdown Documentation Engine",
    desc: "A tiny live Markdown renderer — type left, preview right.",
    entry: "md.js",
    files: {
      "styles.css": NEON_CSS + `body{align-items:stretch}.split{display:grid;grid-template-columns:1fr 1fr;gap:14px;width:100%;min-height:300px}textarea{width:100%;height:300px;background:#0d1322;color:#cfe;border:1px solid #2a3b5c;border-radius:10px;padding:12px;font-family:monospace}#out{text-align:left}`,
      "index.html": NEON_PAGE(
        "Markdown Engine",
        `<h1>📝 Markdown <span class="glow">Engine</span></h1>\n<div class="split"><textarea id="src"># Hello NeonDeck\n\nType **markdown** and watch it _render_ live.\n\n- bullet one\n- bullet two</textarea><div id="out" class="card"></div></div>\n<script src="md.js"></script>`,
      ),
      "md.js": `function render(md) {
  return md
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/\\n/g, "<br/>");
}
const src = document.getElementById("src");
const out = document.getElementById("out");
const update = () => (out.innerHTML = render(src.value));
src.addEventListener("input", update);
update();
`,
    },
  },
  {
    id: "threejs-cube",
    emoji: "🧊",
    title: "Three.js 3D Floating Cube Demo",
    desc: "A spinning neon wireframe cube via the Three.js CDN.",
    entry: "scene.js",
    files: {
      "styles.css": NEON_CSS + "canvas{display:block}",
      "index.html": NEON_PAGE(
        "Three.js Cube",
        `<h1>🧊 Floating <span class="glow">Cube</span></h1>\n<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>\n<script src="scene.js"></script>`,
      ),
      "scene.js": `const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 360 / 260, 0.1, 100);
camera.position.z = 3;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(360, 260);
document.body.appendChild(renderer.domElement);
const geo = new THREE.BoxGeometry();
const mat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, wireframe: true });
const cube = new THREE.Mesh(geo, mat);
scene.add(cube);
function animate() {
  requestAnimationFrame(animate);
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.014;
  renderer.render(scene, camera);
}
animate();
`,
    },
  },
  {
    id: "weather-dashboard",
    emoji: "🌦️",
    title: "Vanilla JS Weather Dashboard",
    desc: "A mock weather card UI with switchable cities (no API key).",
    entry: "weather.js",
    files: {
      "styles.css": NEON_CSS + ".temp{font-size:60px;font-weight:900}.row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}",
      "index.html": NEON_PAGE(
        "Weather",
        `<h1>🌦️ <span class="glow">Weather</span></h1>\n<div class="row" id="cities"></div>\n<div class="card"><div id="name" class="pink"></div><div class="temp glow" id="temp"></div><div id="desc"></div></div>\n<script src="weather.js"></script>`,
      ),
      "weather.js": `const data = {
  Tokyo: { t: 21, d: "☁️ Cloudy" },
  Reykjavik: { t: 4, d: "❄️ Snow" },
  Dubai: { t: 38, d: "☀️ Clear" },
  Lagos: { t: 29, d: "🌧️ Rain" },
};
const cities = document.getElementById("cities");
function show(name) {
  document.getElementById("name").textContent = name;
  document.getElementById("temp").textContent = data[name].t + "°C";
  document.getElementById("desc").textContent = data[name].d;
}
Object.keys(data).forEach((c) => {
  const b = document.createElement("button");
  b.textContent = c;
  b.onclick = () => show(c);
  cities.appendChild(b);
});
show("Tokyo");
`,
    },
  },
  {
    id: "websocket-chat",
    emoji: "💬",
    title: "WebSocket Chat Interface",
    desc: "A chat UI with a simulated echo bot (front-end only).",
    entry: "chat.js",
    files: {
      "styles.css": NEON_CSS + `body{align-items:stretch}#log{height:240px;overflow:auto;text-align:left}.me{color:var(--cyan)}.bot{color:var(--pink)}.bar{display:flex;gap:8px}.bar input{flex:1;padding:10px;border-radius:8px;border:1px solid #2a3b5c;background:#0d1322;color:#fff}`,
      "index.html": NEON_PAGE(
        "WebSocket Chat",
        `<h1>💬 <span class="glow">Live</span> Chat</h1>\n<div id="log" class="card"></div>\n<div class="bar"><input id="msg" placeholder="Say something..." /><button onclick="send()">Send</button></div>\n<script src="chat.js"></script>`,
      ),
      "chat.js": `// Swap the simulated socket below for: new WebSocket("ws://localhost:8081")
const log = document.getElementById("log");
function line(who, text, cls) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = who + ": " + text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}
function send() {
  const input = document.getElementById("msg");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  line("you", text, "me");
  setTimeout(() => line("echo-bot", text.split("").reverse().join(""), "bot"), 400);
}
line("echo-bot", "Connected. I reverse everything you say!", "bot");
`,
    },
  },
];
