/** The watch page. Inlined so there is no build step and no asset to serve. */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Shura — agents at work</title>
<style>
  :root {
    --bg: #0f1115; --panel: #161920; --line: #262b36; --text: #e6e8ee;
    --muted: #8b93a7; --accent: #3C9289; --warn: #E06D52; --bad: #CE1126;
    --produce: #428CB0; --verify: #3C9289; --admit: #9a7fd1; --plan: #C9A227;
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
  .plan { color:var(--plan); }
  .body { white-space:pre-wrap; word-break:break-word; }
  .phase { background:var(--panel); border-left:3px solid var(--accent); padding:6px 10px;
           margin:8px 0; border-radius:0 6px 6px 0; }
  .denied { color:var(--warn); }
  .error  { color:var(--bad); }
  .verdict { background:var(--panel); border-left:3px solid var(--admit);
             padding:8px 10px; margin:8px 0; border-radius:0 6px 6px 0; font-weight:600; }
  .idle { color:var(--muted); padding:24px 0; }
  form#new { background:var(--panel); border:1px solid var(--line); margin:14px 20px;
             padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
  form#new h2 { font-size:12px; margin:0; color:var(--muted); letter-spacing:.08em;
                text-transform:uppercase; }
  form#new label { display:flex; flex-direction:column; gap:4px; font-size:12px;
                   color:var(--muted); }
  input, textarea { background:var(--bg); color:var(--text); border:1px solid var(--line);
                    border-radius:4px; padding:8px 10px; font:inherit; font-size:13px; }
  input:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:-1px; }
  textarea { resize:vertical; }
  button { background:var(--accent); color:#fff; border:0; border-radius:4px;
           padding:8px 16px; font:inherit; font-size:13px; cursor:pointer; }
  button:hover:not(:disabled) { filter:brightness(1.1); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  .actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .small { font-size:11px; margin:0; }
  .bad { color:var(--bad); }
  .gate { background:var(--panel); border-left:3px solid var(--plan); margin:0 20px 10px;
          padding:10px 14px; }
  .gate .q { display:flex; flex-direction:column; gap:4px; margin:8px 0; font-size:12px; }
  .gate .q span { color:var(--text); }
  .gate .ignore { display:flex; align-items:center; gap:6px; margin-top:6px; cursor:pointer; }
  input.answer.bad { border-color:var(--bad); }
  .gate h2 { font-size:12px; margin:0 0 6px; color:var(--plan); letter-spacing:.08em;
             text-transform:uppercase; }
  .gate .cmd { color:var(--text); }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%;
         background:var(--accent); margin-right:6px; animation:p 1.4s infinite; }
  @keyframes p { 0%,100%{opacity:.25} 50%{opacity:1} }
</style>
</head>
<body>
<header>
  <h1><span class="dot"></span>Shura</h1>
  <select id="runs"><option value="">all runs</option></select>
  <span class="muted" id="where"></span>
  <div id="stats">
    <span class="muted">tools <b id="tools">0</b></span>
    <span class="muted">denied <b id="denied">0</b></span>
    <span class="muted">spent <b id="usd">$0.0000</b></span>
  </div>
</header>
<form id="new" hidden>
  <h2>New work</h2>
  <label>Repository<input id="repo" placeholder="owner/name" autocomplete="off" spellcheck="false"></label>
  <label>What do you want built or fixed?<textarea id="task" rows="3"
    placeholder="The order list shows nothing when there are no orders. Add a proper empty state."></textarea></label>
  <div class="actions">
    <button type="submit" id="go">Plan it</button>
    <span class="muted" id="cost"></span>
  </div>
  <p class="muted small">It reads the repository and comes back with a plan. Nothing is written
  until you approve it.</p>
</form>
<div id="gate"></div>
<main><div id="log"><p class="idle">Waiting for a run. Start one with <b>shura build --repo &lt;owner/name&gt; --task "&hellip;"</b> in another terminal.</p></div></main>

<script type="module">
const log = document.getElementById('log');
const sel = document.getElementById('runs');
// lastId is why the page no longer re-dumps history. The server has always
// accepted an "after" cursor; the client never sent one, so every connect and
// every silent reconnect replayed the entire events table from row 1.
let source, first = true, tools = 0, denied = 0, usd = 0, lastId = 0;

const el = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
const time = (iso) => new Date(iso).toTimeString().slice(0, 8);
// plan-01 used to fall through to the muted 'sys' grey, because the palette
// predates the planner existing and the planning phase emitted nothing anyway.
const kindOf = (a) => a?.startsWith('plan') ? 'plan'
                    : a?.startsWith('dev') ? 'produce'
                    : a?.startsWith('rev') || a?.startsWith('br') ? 'verify'
                    : a?.startsWith('ba') ? 'produce' : 'sys';

function add(row) {
  if (first) { log.innerHTML = ''; first = false; }
  if (row.id > lastId) lastId = row.id;
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
  const q = new URLSearchParams();
  if (key) q.set('key', key);
  // Resume where we left off. EventSource reconnects on its own after a drop,
  // and it rebuilds the URL from this string, so the cursor has to be in it.
  if (lastId > 0) q.set('after', String(lastId));
  source = new EventSource('/events' + (q.size ? '?' + q : ''));
  source.onmessage = (m) => add(JSON.parse(m.data));
}

let readOnly = true, phase = 'idle', gateKey = null;

/**
 * Plans waiting for a human.
 *
 * On a read-only server this shows the commands that decide it. Under
 * "shura serve" it shows the plan's open questions with a box for each answer,
 * and
 * approving is refused until they are filled — the same rule the CLI enforces.
 * A button that skipped them would make the gate a rubber stamp, which is the
 * one thing it must not be.
 */
async function loadGate() {
  const gate = document.getElementById('gate');
  let plans = [];
  try { plans = await (await fetch('/plans')).json(); } catch { return; }

  // Redraw only when WHICH plans are waiting actually changes.
  //
  // Polling and rebuilding the markup every few seconds throws away whatever
  // the person was in the middle of: a half-typed answer, the focus, and — the
  // one that made this worth fixing — the error explaining why their last
  // click was refused. The refusal worked and looked like nothing happened.
  const key = plans.map((p) => p.id).join(',');
  if (key === gateKey) return;
  gateKey = key;

  if (plans.length === 0) { gate.innerHTML = ''; return; }

  gate.innerHTML = plans.map((p) => {
    const short = p.id.slice(0, 8);
    const q = Number(p.open_questions);
    const head = '<h2>Plan waiting for you</h2>' +
      '<div>' + esc(p.key) + '  ' + esc(p.title ?? '') + '</div>' +
      '<div class="muted">' + esc(p.repo) + ' · ' + p.criteria + ' criteria · ' +
      (q > 0 ? q + ' open question' + (q === 1 ? '' : 's') : 'nothing left open') +
      ' · ' + esc(p.vendor) + '/' + esc(p.model) + ' · $' + Number(p.cost_usd).toFixed(4) +
      '</div>';

    if (readOnly) {
      return '<div class="gate">' + head +
        '<div class="cmd">shura plans ' + short + '</div>' +
        '<div class="cmd">shura approve ' + short +
        (q > 0 ? ' --answer "…"'.repeat(Math.min(q, 3)) : '') + '</div></div>';
    }

    const questions = (p.open_questions_text ?? []).map((text, i) =>
      '<label class="q"><span>' + esc(text) + '</span>' +
      '<input class="answer" data-i="' + i + '" placeholder="your answer"></label>').join('');

    return '<div class="gate" data-plan="' + esc(p.id) + '">' + head +
      '<p class="muted small">Read it in full with <span class="cmd">shura plans ' + short +
      '</span> — the criteria below are what the reviewer judges against.</p>' +
      questions +
      '<div class="actions">' +
        '<button class="approve">Approve &amp; build</button>' +
        '<button class="ghost reject">Reject</button>' +
        '<span class="muted" id="gate-cost"></span>' +
      '</div>' +
      (q > 0
        ? '<label class="small muted ignore"><input type="checkbox" class="ignore-box"> ' +
          'Let the agent decide anything I leave blank</label>'
        : '') +
      '<p class="err bad small"></p></div>';
  }).join('');

  gate.querySelectorAll('.gate[data-plan]').forEach((card) => {
    const id = card.getAttribute('data-plan');
    const err = card.querySelector('.err');
    const answers = () => [...card.querySelectorAll('.answer')].map((a) => a.value);

    card.querySelector('.approve').onclick = async () => {
      err.textContent = '';
      card.querySelectorAll('.answer').forEach((a) => a.classList.remove('bad'));
      const ignore = card.querySelector('.ignore-box');
      await decide(
        card, id, 'approve',
        { answers: answers(), ignoreQuestions: ignore ? ignore.checked : false },
        err,
      );
    };
    card.querySelector('.reject').onclick = async () => {
      const note = prompt('What is wrong with it? The agent cannot do better without a reason.');
      if (note === null || note.trim() === '') return;
      await decide(card, id, 'reject', { note }, err);
    };
  });
  paintCost();
}

async function decide(card, id, action, body, err) {
  card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/plans/' + id + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      // The questions are already on screen; repeating them in the error was
      // three lines of noise. Mark the boxes instead.
      err.textContent = out.error ?? 'that did not work';
      card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      const boxes = [...card.querySelectorAll('.answer')];
      boxes.filter((b) => b.value.trim() === '').forEach((b) => b.classList.add('bad'));
      const empty = boxes.find((b) => b.value.trim() === '');
      if (empty) empty.focus();
      return;
    }
    gateKey = null;
    await loadStatus();
    await loadGate();
  } catch (e) {
    err.textContent = String(e);
    card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

/** Submitting work. The click is the cost consent, so the price sits beside it. */
function wireForm() {
  const form = document.getElementById('new');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const go = document.getElementById('go');
    const cost = document.getElementById('cost');
    go.disabled = true;
    try {
      const res = await fetch('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: document.getElementById('repo').value,
          task: document.getElementById('task').value,
        }),
      });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        cost.innerHTML = '<span class="bad">' + esc(out.error ?? 'that did not work') + '</span>';
        go.disabled = false;
        return;
      }
      document.getElementById('task').value = '';
      await loadStatus();
    } catch (e2) {
      cost.innerHTML = '<span class="bad">' + esc(String(e2)) + '</span>';
      go.disabled = false;
    }
  };
}

let est = null;

function paintCost() {
  if (est === null) return;
  const cost = document.getElementById('cost');
  if (cost && phase === 'idle') {
    cost.textContent = 'calls ' + est.planner + ', up to $' + est.planUsd;
  }
  const gc = document.getElementById('gate-cost');
  if (gc) gc.textContent = 'calls ' + est.builder + ' then ' + est.reviewer + ', up to $' + est.buildUsd;
}

/** Whether this server can be given work, and whether it is busy. */
async function loadStatus() {
  let s;
  try { s = await (await fetch('/status')).json(); } catch { return; }
  readOnly = s.readOnly !== false;
  phase = s.phase ?? 'idle';
  est = s.estimate ?? est;

  const form = document.getElementById('new');
  form.hidden = readOnly;
  const go = document.getElementById('go');
  const cost = document.getElementById('cost');
  const busy = phase !== 'idle';
  go.disabled = busy;
  if (busy) {
    cost.textContent = phase === 'planning'
      ? 'planning ' + (s.repo ?? '') + '…'
      : 'building ' + (s.workItemKey ?? '') + '…';
  } else if (s.lastError) {
    cost.innerHTML = '<span class="bad">' + esc(s.lastError) + '</span>';
  } else if (s.lastPullRequest) {
    cost.innerHTML = 'done — <a href="' + esc(s.lastPullRequest) + '" target="_blank" rel="noopener">' +
      'pull request</a> waiting for you to merge';
  } else {
    paintCost();
  }
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function loadRuns() {
  const runs = await (await fetch('/runs')).json();
  const current = sel.value;
  sel.innerHTML = '<option value="">all runs</option>' +
    runs.map((r) => '<option value="' + r.key + '">' + r.key + ' — ' + (r.title ?? '') + '</option>').join('');
  sel.value = current;
}

sel.onchange = () => { lastId = 0; connect(sel.value); };
wireForm();
await loadStatus();
await loadRuns();
await loadGate();
setInterval(loadRuns, 5000);
setInterval(loadGate, 3000);
setInterval(loadStatus, 2000);
connect('');
</script>
</body>
</html>`;
