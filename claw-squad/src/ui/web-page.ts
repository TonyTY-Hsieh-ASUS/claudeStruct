/**
 * Embedded web UI page — HTML + CSS + JS as a single string.
 *
 * Not a SPA, not a build step, not a framework. We need:
 *   - A status header (active role, totals, per-role rows)
 *   - A TODO panel
 *   - A streaming activity log
 *   - A form that surfaces over the log when the server asks a
 *     clarification or a confirm
 *
 * That's well under 300 lines of vanilla JS. Keeping it embedded
 * means `claw-squad run --web-ui 3737` is a single self-contained
 * server — no `npm install` on the UI side.
 */

export const WEB_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>claw-squad</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --dim: #8b949e;
    --planner: #79c0ff;
    --coder: #7ee787;
    --reviewer: #ffa657;
    --subagent: #d2a8ff;
    --orchestrator: #c9d1d9;
    --warn: #f0883e;
    --ok: #56d364;
  }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    margin: 0; padding: 16px;
  }
  h1 { font-size: 16px; margin: 0 0 12px; color: var(--planner); }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 12px; margin-bottom: 12px;
  }
  .row { display: flex; gap: 12px; align-items: baseline; }
  .role-planner { color: var(--planner); }
  .role-coder { color: var(--coder); }
  .role-reviewer { color: var(--reviewer); }
  .role-subagent { color: var(--subagent); }
  .role-orchestrator { color: var(--orchestrator); }
  .dim { color: var(--dim); }
  .todos li { list-style: none; padding: 2px 0; }
  .todo-done { color: var(--ok); }
  .todo-in_progress { color: var(--warn); }
  .todo-abandoned { color: #f85149; }
  #activity {
    height: 50vh; overflow-y: auto; white-space: pre-wrap;
    font-size: 12px;
  }
  #activity div { padding: 1px 0; }
  #prompt {
    background: #1c2128; border: 2px solid var(--warn);
    padding: 12px; margin-top: 12px; border-radius: 6px;
    display: none;
  }
  #prompt.visible { display: block; }
  #prompt input, #prompt button {
    background: #0d1117; color: var(--text);
    border: 1px solid var(--border); padding: 6px 10px;
    font: inherit; border-radius: 4px;
  }
  #prompt input { width: 60%; margin-right: 8px; }
  #prompt button { cursor: pointer; }
  .disconnected { color: #f85149; }
</style>
</head>
<body>
<h1>claw-squad <span id="conn" class="dim">connecting…</span></h1>

<div class="panel" id="header">
  <div class="row">
    <strong>active:</strong> <span id="active">idle</span>
    <span class="dim">subagent:</span> <span id="subagent" class="dim">—</span>
  </div>
  <div class="row dim" id="totals">calls 0 · $0.0000</div>
  <div id="perRole"></div>
</div>

<div class="panel">
  <strong>TODOs</strong>
  <ul class="todos" id="todos"></ul>
</div>

<div class="panel">
  <strong>Activity</strong>
  <div id="activity"></div>
</div>

<div id="prompt">
  <div id="promptText" class="dim"></div>
  <div style="margin-top:8px;">
    <input id="promptInput" type="text" autofocus />
    <button id="promptSend">send</button>
  </div>
</div>

<script>
(function(){
  var conn = document.getElementById('conn');
  var active = document.getElementById('active');
  var subagent = document.getElementById('subagent');
  var totals = document.getElementById('totals');
  var perRole = document.getElementById('perRole');
  var todos = document.getElementById('todos');
  var activity = document.getElementById('activity');
  var prompt = document.getElementById('prompt');
  var promptText = document.getElementById('promptText');
  var promptInput = document.getElementById('promptInput');
  var promptSend = document.getElementById('promptSend');

  var pendingPrompt = null;
  var ws;

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = function(){ conn.textContent = 'connected'; conn.classList.remove('disconnected'); };
    ws.onclose = function(){
      conn.textContent = 'disconnected — retrying';
      conn.classList.add('disconnected');
      setTimeout(connect, 2000);
    };
    ws.onerror = function(){};
    ws.onmessage = function(ev){
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handle(msg);
    };
  }

  function handle(msg){
    switch(msg.type){
      case 'snapshot': {
        if (msg.active) active.textContent = msg.active;
        if (msg.subagent) subagent.textContent = msg.subagent;
        if (msg.totals) renderTotals(msg.totals);
        if (msg.perRole) renderPerRole(msg.perRole);
        if (msg.todos) renderTodos(msg.todos);
        if (msg.logs) msg.logs.forEach(appendLine);
        if (msg.prompt) showPrompt(msg.prompt);
        break;
      }
      case 'log':
        appendLine({ role: msg.role, text: msg.text, ts: msg.ts });
        break;
      case 'totals':
        renderTotals(msg.totals);
        if (msg.perRole) renderPerRole(msg.perRole);
        break;
      case 'active':
        active.textContent = msg.role || 'idle';
        break;
      case 'subagent':
        subagent.textContent = msg.name || '—';
        break;
      case 'todos':
        renderTodos(msg.todos);
        break;
      case 'prompt':
        showPrompt(msg.prompt);
        break;
      case 'prompt-clear':
        hidePrompt();
        break;
    }
  }

  function renderTotals(t){
    totals.textContent =
      'calls ' + t.calls + ' · $' + (t.costUsd || 0).toFixed(4)
      + ' · cache saved $' + (t.cacheSavedUsd || 0).toFixed(4);
  }

  function renderPerRole(pr){
    perRole.innerHTML = '';
    Object.keys(pr).forEach(function(role){
      var r = pr[role];
      if (!r.calls) return;
      var div = document.createElement('div');
      div.className = 'role-' + role;
      div.textContent = role + ': ' + r.calls + '× · $' + (r.costUsd || 0).toFixed(4);
      perRole.appendChild(div);
    });
  }

  function renderTodos(list){
    todos.innerHTML = '';
    list.forEach(function(t){
      var li = document.createElement('li');
      li.className = 'todo-' + t.status;
      var glyph = t.status === 'done' ? '✓' :
                  t.status === 'in_progress' ? '◐' :
                  t.status === 'abandoned' ? '✗' : '·';
      li.textContent = glyph + ' ' + t.id + '  ' + t.title +
        (t.rolledBack ? '  ↺' : '') +
        (t.mergedPrNumber ? '  (#' + t.mergedPrNumber + ')' : '');
      todos.appendChild(li);
    });
  }

  function appendLine(line){
    var div = document.createElement('div');
    div.className = 'role-' + (line.role || 'orchestrator');
    div.textContent = (line.ts ? line.ts + '  ' : '') + line.text;
    activity.appendChild(div);
    activity.scrollTop = activity.scrollHeight;
  }

  function showPrompt(p){
    pendingPrompt = p;
    prompt.classList.add('visible');
    promptText.textContent = p.text;
    promptInput.value = '';
    promptInput.focus();
  }
  function hidePrompt(){
    pendingPrompt = null;
    prompt.classList.remove('visible');
    promptText.textContent = '';
  }

  promptSend.addEventListener('click', sendReply);
  promptInput.addEventListener('keydown', function(e){
    if (e.key === 'Enter') sendReply();
  });

  function sendReply(){
    if (!pendingPrompt || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'prompt-reply',
      promptId: pendingPrompt.id,
      value: promptInput.value
    }));
  }

  connect();
})();
</script>
</body>
</html>
`;
