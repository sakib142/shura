/** The watch page. Inlined so there is no build step and no asset to serve. */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Forge — agents at work</title>
<style>
  :root {
    --bg: #0f1115; --panel: #161920; --line: #262b36; --text: #e6e8ee;
    --muted: #8b93a7; --accent: #3C9289; --warn: #E06D52; --bad: #CE1126;
    --produce: #428CB0; --verify: #3C9289; --admit: #9a7fd1;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f7f8fa; --panel:#fff; --line:#e3e6ec; --text:#1a1d24; --muted:#6b7280; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:14px 20px; border-bottom:1px solid var(--line);
           display:flex; gap:18px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  .muted { color:var(--muted); }
  select { background:var(--panel); color:var(--text); border:1px solid var(--line);
           border-radius:6px; padding:5px 8px; font:inherit; }
  #stats { margin-left:auto; display:flex; gap:16px; }
  #stats b { font-weight:600; }
  main { padding:14px 20px 40px; }
  .row { display:grid; grid-template-columns:72px 110px 1fr; gap:12px;
         padding:4px 0; border-bottom:1px solid var(--line); align-items:start; }
  .row:hover { background:var(--panel); }
  .t { color:var(--muted); }
  .actor { font-weight:600; }
  .produce { color:var(--produce); } .verify { color:var(--verify); }
  .admit { color:var(--admit); } .sys { color:var(--muted); }
  .body { white-space:pre-wrap; word-break:break-word; }
  .phase { background:var(--panel); border-left:3px solid var(--accent); padding:6px 10px;
           margin:8px 0; border-radius:0 6px 6px 0; }
  .denied { color:var(--warn); }
  .error  { color:var(--bad); }
  .verdict { background:var(--panel); border-left:3px solid var(--admit);
             padding:8px 10px; margin:8px 0; border-radius:0 6px 6px 0; font-weight:600; }
  .idle { color:var(--muted); padding:24px 0; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%;
         background:var(--accent); margin-right:6px; animation:p 1.4s infinite; }
  @keyframes p { 0%,100%{opacity:.25} 50%{opacity:1} }
</style>
</head>
<body>
<header>
  <h1><span class="dot"></span>Forge</h1>
  <select id="runs"><option value="">all runs</option></select>
  <span class="muted" id="where"></span>
  <div id="stats">
    <span class="muted">tools <b id="tools">0</b></span>
    <span class="muted">denied <b id="denied">0</b></span>
    <span class="muted">spent <b id="usd">$0.0000</b></span>
  </div>
</header>
<main><div id="log"><p class="idle">Waiting for a run. Start one with <b>forge run &lt;ITEM&gt;</b> in another terminal.</p></div></main>

<script type="module">
const log = document.getElementById('log');
const sel = document.getElementById('runs');
let source, first = true, tools = 0, denied = 0, usd = 0;

const el = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
const time = (iso) => new Date(iso).toTimeString().slice(0, 8);
const kindOf = (a) => a?.startsWith('dev') ? 'produce' : a?.startsWith('rev') || a?.startsWith('br') ? 'verify'
                    : a?.startsWith('ba') ? 'produce' : 'sys';

function add(row) {
  if (first) { log.innerHTML = ''; first = false; }
  const p = row.payload;
  const d = document.createElement('div');

  if (p.kind === 'phase') {
    d.className = 'phase';
    d.textContent = p.state + '   ' + p.detail;
  } else if (p.kind === 'verdict') {
    d.className = 'verdict';
    d.textContent = 'VERDICT ' + p.decision + '   ' + p.detail;
  } else if (p.kind === 'note') {
    d.className = 'row';
    d.append(el('t', time(row.at)), el('actor sys', ''), el('body muted', p.text));
  } else if (p.kind === 'agent') {
    const e = p.event, actor = p.actor;
    let body = null, cls = 'body';
    if (e.t === 'tool_call') { tools++; body = e.tool + '  ' + JSON.stringify(e.args).slice(0, 160); }
    else if (e.t === 'tool_result' && !e.ok) { denied++; cls = 'body denied'; body = 'DENIED ' + (e.denialReason ?? ''); }
    else if (e.t === 'file_change') { body = 'wrote ' + e.path; }
    else if (e.t === 'usage') { usd = e.usd; body = e.tokensIn + '/' + e.tokensOut + ' tok'; }
    else if (e.t === 'error') { cls = 'body error'; body = 'ERROR ' + e.message; }
    else if (e.t === 'result') { body = 'finished'; }
    if (body === null) return;
    d.className = 'row';
    d.append(el('t', time(row.at)), el('actor ' + kindOf(actor), actor), el(cls, body));
  } else return;

  log.append(d);
  document.getElementById('tools').textContent = tools;
  document.getElementById('denied').textContent = denied;
  document.getElementById('usd').textContent = '$' + usd.toFixed(4);
  window.scrollTo(0, document.body.scrollHeight);
}

function connect(key) {
  source?.close();
  log.innerHTML = '<p class="idle">Waiting…</p>';
  first = true; tools = 0; denied = 0; usd = 0;
  document.getElementById('where').textContent = key ? 'watching ' + key : 'watching everything';
  source = new EventSource('/events' + (key ? '?key=' + encodeURIComponent(key) : ''));
  source.onmessage = (m) => add(JSON.parse(m.data));
}

async function loadRuns() {
  const runs = await (await fetch('/runs')).json();
  const current = sel.value;
  sel.innerHTML = '<option value="">all runs</option>' +
    runs.map((r) => '<option value="' + r.key + '">' + r.key + ' — ' + (r.title ?? '') + '</option>').join('');
  sel.value = current;
}

sel.onchange = () => connect(sel.value);
await loadRuns();
setInterval(loadRuns, 5000);
connect('');
</script>
</body>
</html>`;
