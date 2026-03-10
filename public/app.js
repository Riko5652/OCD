// AI Productivity Dashboard V2 — app.js
/* global Chart */

const S = {
  overview: null, sessions: null, compare: null, models: null,
  recs: null, efficiency: null, commits: null, cursorDaily: null,
  codeGen: null, insights: null, costs: null, personal: null,
  insProfile: null, insTrends: null, insPrompt: null, insLlmStatus: null,
  details: {}, tab: 'overview', sse: false, charts: {},
};

// ---- Helpers ----
const $ = id => document.getElementById(id);
function fmt(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fD(ts) {
  if (!ts) return '--';
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fT(ts) {
  if (!ts) return '--';
  return new Date(typeof ts === 'number' ? ts : Date.parse(ts))
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function pct(a, b) { return b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '0%'; }
function dc(id) { if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; } }
function mc(id, cfg) { dc(id); const c = new Chart($(id), cfg); S.charts[id] = c; return c; }
function kpi(v, l, col) {
  return `<div class="kc" style="border-left-color:var(${col})"><div class="kv">${v}</div><div class="kl">${l}</div></div>`;
}

const TOOL_COLORS = { 'claude-code': '#d97706', cursor: '#8b5cf6', antigravity: '#06b6d4' };
const MODEL_COLORS = ['#F15A2B', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#84cc16'];
function toolColor(id) { return TOOL_COLORS[id] || '#64748b'; }
function toolChip(id) {
  const cls = id === 'claude-code' ? 'tool-claude' : id === 'cursor' ? 'tool-cursor' : id === 'antigravity' ? 'tool-antigravity' : '';
  return `<span class="chip ${cls}">${id}</span>`;
}
function parseJSON(s) { try { return JSON.parse(s); } catch { return []; } }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---- Issue Banner ----
let bannerDismissed = false;

function renderIssueBanner(recs) {
  const banner = $('issue-banner');
  if (!banner || bannerDismissed) return;
  const active = (recs || []).filter(r => !r.dismissed && (r.severity === 'critical' || r.severity === 'warning'));
  if (active.length === 0) { banner.className = ''; return; }
  const hasCrit = active.some(r => r.severity === 'critical');
  const top2 = active.slice(0, 2).map(r => r.title).join(' · ');
  $('ib-msg').textContent = `⚠ ${active.length} active issue${active.length > 1 ? 's' : ''} — ${top2}`;
  banner.className = hasCrit ? 'has-crit' : 'has-warn';
}

// ---- Fetch ----
async function fJ(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

// ---- SSE ----
function initSSE() {
  const es = new EventSource('/api/live');
  es.onopen = () => { S.sse = true; uLive(); };
  es.addEventListener('refresh', () => refreshAll());
  es.addEventListener('coach', (e) => {
    try {
      const nudges = JSON.parse(e.data);
      if (Array.isArray(nudges) && nudges.length) showCoachNudges(nudges);
    } catch { /* malformed */ }
  });
  es.onerror = () => { S.sse = false; uLive(); setTimeout(initSSE, 5000); };
}
function uLive() {
  $('dot').classList.toggle('on', S.sse);
  $('dtxt').textContent = S.sse ? 'Live' : 'Disconnected';
}
// ---- Update check ----
async function checkForUpdate() {
  try {
    const data = await fJ('/api/version-check');
    if (!data || !data.updateAvailable || !data.latest) return;
    if (sessionStorage.getItem('dismiss-update-' + data.latest)) return;
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10001;background:linear-gradient(90deg,#6366f1,#8b5cf6);color:#fff;padding:8px 16px;font-size:.82rem;display:flex;align-items:center;justify-content:center;gap:12px';
    const msg = document.createElement('span');
    msg.textContent = `v${data.latest} is available (you have v${data.current}). Run: npm update -g ai-productivity-dashboard`;
    const close = document.createElement('button');
    close.textContent = '\u00d7';
    close.style.cssText = 'background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;margin-left:8px';
    close.onclick = () => { sessionStorage.setItem('dismiss-update-' + data.latest, '1'); banner.remove(); };
    banner.appendChild(msg);
    banner.appendChild(close);
    document.body.prepend(banner);
  } catch (_) { /* silently ignore */ }
}

function showCoachNudges(nudges) {
  let container = document.getElementById('coach-nudges');
  if (!container) {
    container = document.createElement('div');
    container.id = 'coach-nudges';
    container.style.cssText = 'position:fixed;bottom:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem;max-width:360px';
    document.body.appendChild(container);
  }
  for (const nudge of nudges) {
    const key = `coach-dismissed-${nudge.id}`;
    if (sessionStorage.getItem(key)) continue;
    const color = nudge.severity === 'warning' ? 'var(--status-warning,#f59e0b)' : 'var(--primary,#6366f1)';
    const toast = document.createElement('div');
    toast.style.cssText = `background:var(--surface-light,#f8f8f8);border:1px solid var(--border-light,#e0e0e0);border-left:4px solid ${color};border-radius:var(--radius-card,8px);padding:.75rem 1rem;box-shadow:var(--shadow-float,0 4px 12px rgba(0,0,0,.1));font-size:.85rem;color:var(--text-main,#111)`;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem';
    const span = document.createElement('span');
    span.textContent = nudge.message;
    const btn = document.createElement('button');
    btn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--text-secondary,#666);font-size:1.1rem;line-height:1;flex-shrink:0';
    btn.dataset.key = key;
    btn.textContent = '\u00d7';
    wrapper.appendChild(span);
    wrapper.appendChild(btn);
    toast.appendChild(wrapper);
    btn.onclick = function () {
      sessionStorage.setItem(this.dataset.key, '1');
      toast.remove();
    };
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 30000);
  }
}

// ---- Tab navigation ----
function initTabs() {
  document.querySelectorAll('.tb').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tb').forEach(x => x.classList.remove('a'));
    b.classList.add('a');
    document.querySelectorAll('.tp').forEach(x => x.classList.remove('a'));
    $('t-' + b.dataset.t).classList.add('a');
    S.tab = b.dataset.t;
    onTab(b.dataset.t);
  }));
}
function onTab(t) {
  // Refresh banner on every tab switch
  if (!S.recs) {
    fJ('/api/recommendations?all=true').then(r => { S.recs = r; renderIssueBanner(r); });
  } else {
    renderIssueBanner(S.recs);
  }
  if (t === 'overview') rOv();
  if (t === 'sessions') rSess();
  if (t === 'tokens') rTok();
  if (t === 'compare') rCompare();
  if (t === 'commits') rCommits();
  if (t === 'codegen') rCG();
  if (t === 'analytics') rAna();
  if (t === 'costs') rCosts();
  if (t === 'personal') rPersonal();
  if (t === 'optimize') rOpt();
  if (t === 'insights') rIns();
  if (t === 'projects') rProjects();
  if (t === 'models') rModels();
}

async function refreshAll() {
  // Clear cached data so tabs re-fetch fresh data
  S.compare = null; S.models = null; S.recs = null; S.efficiency = null;
  S.commits = null; S.cursorDaily = null; S.codeGen = null; S.insights = null; S.costs = null; S.personal = null;
  S.insProfile = null; S.insTrends = null; S.insPrompt = null; S.insLlmStatus = null;
  projectsData = null; modelsData = null; winRatesData = null;

  const [ov, sr] = await Promise.all([fJ('/api/overview'), fJ('/api/sessions?limit=500')]);
  if (ov) S.overview = ov;
  if (sr?.sessions) S.sessions = sr.sessions;
  $('upd').textContent = 'Updated ' + new Date().toLocaleTimeString();
  onTab(S.tab);
}

// ==============================================================
// OVERVIEW TAB
// ==============================================================
let ovRange = 0;

async function rOv() {
  if (!S.overview) S.overview = await fJ('/api/overview');
  if (!S.recs) S.recs = await fJ('/api/recommendations');
  const o = S.overview;
  if (!o) return;

  const { tools, global: g, today, commits } = o;
  // Fetch daily with selected range
  const daily = await fJ(`/api/daily?days=${ovRange}`);

  // KPIs
  const todayTurns = (today || []).reduce((s, t) => s + (t.turns || t.count || 0), 0);
  $('k-ov').innerHTML = [
    kpi(fmt(g?.total_sessions), 'Total Sessions', '--primary'),
    kpi(fmt(g?.total_turns), 'Total Turns', '--c-input'),
    kpi(fmt(g?.total_output), 'Output Tokens', '--c-output'),
    kpi(g?.avg_cache_pct != null ? Math.round(g.avg_cache_pct) + '%' : '--', 'Avg Cache Hit', '--c-cache-read'),
    kpi(commits?.avg_ai_pct != null ? Math.round(commits.avg_ai_pct) + '%' : '--', 'AI Authorship', '--c-cache-create'),
    kpi(fmt(todayTurns), "Today's Turns", '--lv-good'),
  ].join('');

  // Top recommendations on overview
  const recs = (S.recs || []).filter(r => !r.dismissed);
  $('ov-recs').innerHTML = recs.slice(0, 4).map(r =>
    `<div class="rc ${r.severity}"><div class="rc-cat">${r.category}</div><div class="rc-t">${r.title}</div><div class="rc-d">${r.description}</div></div>`
  ).join('');

  // Daily turns by tool (stacked bar)
  if (daily?.length > 0) {
    const dates = [...new Set(daily.map(d => d.date))].sort();
    const toolIds = [...new Set(daily.map(d => d.tool_id))];
    mc('c-daily-turns', {
      type: 'bar',
      data: {
        labels: dates.map(d => d.slice(5)),
        datasets: toolIds.map(tid => ({
          label: tid,
          data: dates.map(date => {
            const row = daily.find(d => d.date === date && d.tool_id === tid);
            return row?.total_turns || 0;
          }),
          backgroundColor: toolColor(tid),
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { stacked: true, ticks: { maxRotation: 45, maxTicksLimit: 15 } },
          y: { stacked: true, beginAtZero: true },
        },
      },
    });

    // Daily output tokens (line chart)
    mc('c-daily-output', {
      type: 'line',
      data: {
        labels: dates.map(d => d.slice(5)),
        datasets: toolIds.map(tid => ({
          label: tid,
          data: dates.map(date => {
            const row = daily.find(d => d.date === date && d.tool_id === tid);
            return row?.total_output_tokens || 0;
          }),
          borderColor: toolColor(tid),
          backgroundColor: toolColor(tid) + '18',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { ticks: { maxRotation: 45, maxTicksLimit: 15 } },
          y: { beginAtZero: true, ticks: { callback: v => fmt(v) } },
        },
      },
    });
  }

  // Tool distribution bars
  if (tools?.length > 0) {
    const mxS = Math.max(...tools.map(t => t.sessions));
    $('tool-bars').innerHTML = tools.map(t => {
      const c = toolColor(t.tool_id);
      return `
        <div class="br">
          <div class="bl">${toolChip(t.tool_id)}</div>
          <div class="bt"><div class="bf" style="width:${mxS ? (t.sessions / mxS * 100).toFixed(1) : 0}%;background:${c}"></div></div>
          <div class="bv">${t.sessions} sessions</div>
        </div>
        <div style="font-size:.72rem;color:var(--text-s);margin:-4px 0 8px 138px">
          ${fmt(t.turns)} turns | ${fmt(t.output_tokens)} output | cache ${t.avg_cache_pct != null ? Math.round(t.avg_cache_pct) + '%' : '--'}
        </div>`;
    }).join('');
  }
}

// ==============================================================
// SESSIONS TAB
// ==============================================================
let sSort = 'date-desc', sFilt = '', sTool = '';

function rSess() {
  if (!S.sessions) { fJ('/api/sessions?limit=500').then(r => { if (r?.sessions) { S.sessions = r.sessions; rSess(); } }); return; }

  let list = [...S.sessions];

  // Filter by tool
  if (sTool) list = list.filter(s => s.tool_id === sTool);

  // Filter by search
  if (sFilt) {
    const q = sFilt.toLowerCase();
    list = list.filter(s =>
      (s.id + ' ' + (s.title || '') + ' ' + (s.primary_model || '') + ' ' + (s.tool_id || ''))
        .toLowerCase().includes(q)
    );
  }

  // Sort
  const sortFns = {
    'date-desc': (a, b) => (b.started_at || 0) - (a.started_at || 0),
    'date-asc': (a, b) => (a.started_at || 0) - (b.started_at || 0),
    'turns-desc': (a, b) => (b.total_turns || 0) - (a.total_turns || 0),
    'cache-asc': (a, b) => (a.cache_hit_pct || 0) - (b.cache_hit_pct || 0),
    'output-desc': (a, b) => (b.total_output_tokens || 0) - (a.total_output_tokens || 0),
  };
  list.sort(sortFns[sSort] || sortFns['date-desc']);

  const tb = $('s-body');
  tb.innerHTML = list.map(s => {
    const topTools = typeof s.top_tools === 'string' ? parseJSON(s.top_tools) : (s.top_tools || []);
    const toolChips = topTools.slice(0, 3).map(t => {
      const name = Array.isArray(t) ? t[0] : (t.name || t);
      const cnt = Array.isArray(t) ? t[1] : '';
      return `<span class="chip">${String(name).replace('mcp__', '').slice(0, 14)}${cnt ? ' (' + cnt + ')' : ''}</span>`;
    }).join('') + (topTools.length > 3 ? `<span class="chip">+${topTools.length - 3}</span>` : '');

    return `<tr class="sr" data-sid="${s.id}">
      <td>${toolChip(s.tool_id)}${s.meta ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:.68rem;font-weight:700;background:rgba(241,90,43,0.1);color:#F15A2B;border-radius:50px;padding:1px 7px;margin-left:6px" title="This session built this dashboard">&#x221e; Meta</span>' : ''}</td>
      <td style="white-space:nowrap">${fD(s.started_at)}</td>
      <td class="num">${s.total_turns || 0}</td>
      <td class="num">${fmt(s.total_output_tokens)}</td>
      <td class="num">${s.cache_hit_pct != null ? Math.round(s.cache_hit_pct) + '%' : '--'}</td>
      <td class="num">${s.avg_latency_ms ? (s.avg_latency_ms / 1000).toFixed(1) + 's' : '--'}</td>
      <td>${(s.primary_model || '').replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 14)}</td>
      <td>${toolChips}</td>
      <td><span class="ea" id="a-${CSS.escape(s.id)}">&#9654;</span></td>
    </tr>
    <tr id="d-${CSS.escape(s.id)}" style="display:none"><td colspan="9" class="td-cell">
      <div class="td-wrap" id="w-${CSS.escape(s.id)}"><em style="color:#aaa">Loading...</em></div>
    </td></tr>`;
  }).join('');

  // Click handlers for expand
  tb.querySelectorAll('.sr').forEach(r => r.addEventListener('click', () => togDetail(r.dataset.sid)));
}

async function togDetail(sid) {
  const esc = CSS.escape(sid);
  const dr = $('d-' + esc), ar = $('a-' + esc);
  if (!dr) return;
  if (dr.style.display !== 'none') { dr.style.display = 'none'; ar?.classList.remove('open'); return; }
  dr.style.display = ''; ar?.classList.add('open');

  // Load session detail with turns
  if (!S.details[sid]) {
    const data = await fJ('/api/sessions/' + encodeURIComponent(sid));
    if (data) S.details[sid] = data;
  }
  const data = S.details[sid];
  const wrap = $('w-' + esc);
  if (!data) { wrap.innerHTML = '<em style="color:var(--lv-warn)">Failed to load</em>'; return; }

  const turns = data.turns || [];
  if (turns.length === 0) { wrap.innerHTML = '<em style="color:#aaa">No turns recorded</em>'; return; }

  const mx = Math.max(...turns.map(t => (t.input_tokens || 0) + (t.cache_read || 0) + (t.cache_create || 0) + (t.output_tokens || 0)), 1);
  const w = v => ((v / mx) * 100).toFixed(1);

  wrap.innerHTML = `<table><thead><tr>
    <th>Time</th><th>Tokens</th><th class="num">Input</th><th class="num">Cache Read</th>
    <th class="num">Cache Create</th><th class="num">Output</th><th class="num">Latency</th>
    <th class="num">Tok/s</th><th>Tools</th><th>Preview</th>
  </tr></thead><tbody>` + turns.map(t => {
    const tools = typeof t.tools_used === 'string' ? parseJSON(t.tools_used) : (t.tools_used || []);
    const chips = tools.slice(0, 2).map(n => `<span class="chip">${String(n).replace('mcp__', '').slice(0, 14)}</span>`).join('')
      + (tools.length > 2 ? `<span class="chip">+${tools.length - 2}</span>` : '');
    return `<tr>
      <td style="white-space:nowrap;color:#888;font-size:.74rem">${fT(t.timestamp)}</td>
      <td><div class="ts" title="in:${t.input_tokens} cr:${t.cache_read} cc:${t.cache_create} out:${t.output_tokens}">
        <span class="ts-i" style="width:${w(t.input_tokens)}%"></span>
        <span class="ts-cr" style="width:${w(t.cache_read)}%"></span>
        <span class="ts-cc" style="width:${w(t.cache_create)}%"></span>
        <span class="ts-o" style="width:${w(t.output_tokens)}%"></span>
      </div></td>
      <td class="num">${fmt(t.input_tokens)}</td>
      <td class="num" style="color:var(--c-cache-read)">${fmt(t.cache_read)}</td>
      <td class="num" style="color:var(--c-cache-create)">${fmt(t.cache_create)}</td>
      <td class="num" style="color:var(--c-output)">${fmt(t.output_tokens)}</td>
      <td class="num">${t.latency_ms ? (t.latency_ms / 1000).toFixed(1) + 's' : '--'}</td>
      <td class="num">${t.tok_per_sec ?? '--'}</td>
      <td>${chips}</td>
      <td class="snip" title="${(t.label || '').replace(/"/g, '&quot;')}">${t.label || ''}</td>
    </tr>`;
  }).join('') + '</tbody></table>';
}

// ==============================================================
// TOKEN DEEP DIVE TAB
// ==============================================================
async function rTok() {
  if (!S.overview) S.overview = await fJ('/api/overview');
  if (!S.sessions) { const r = await fJ('/api/sessions?limit=500'); if (r?.sessions) S.sessions = r.sessions; }
  const o = S.overview;
  if (!o) return;

  const sess = S.sessions || [];

  // Per-tool token aggregates
  const perTool = {};
  for (const s of sess) {
    const t = s.tool_id || 'unknown';
    if (!perTool[t]) perTool[t] = { input: 0, output: 0, cache_read: 0, cache_create: 0, sessions: 0, turns: 0 };
    perTool[t].input += (s.total_input_tokens || 0);
    perTool[t].output += (s.total_output_tokens || 0);
    perTool[t].cache_read += (s.total_cache_read || 0);
    perTool[t].cache_create += (s.total_cache_create || 0);
    perTool[t].sessions++;
    perTool[t].turns += (s.total_turns || 0);
  }

  // Global aggregates
  const agg = { input: 0, cache_read: 0, cache_create: 0, output: 0 };
  for (const t of Object.values(perTool)) {
    agg.input += t.input; agg.output += t.output;
    agg.cache_read += t.cache_read; agg.cache_create += t.cache_create;
  }

  // KPIs — show total output per tool
  $('k-tok').innerHTML = [
    kpi(fmt(agg.output), 'Total Output Tokens', '--c-output'),
    kpi(fmt(agg.input), 'Input (uncached)', '--c-input'),
    kpi(fmt(agg.cache_read), 'Cache Read', '--c-cache-read'),
    kpi(fmt(agg.cache_create), 'Cache Created', '--c-cache-create'),
  ].join('');

  // Breakdown bars — per-tool output + cache
  const toolBars = Object.entries(perTool).map(([tid, t]) => [
    { l: `${tid} Output`, v: t.output, c: toolColor(tid) },
    ...(t.cache_read > 0 ? [{ l: `${tid} Cache Read`, v: t.cache_read, c: 'var(--c-cache-read)' }] : []),
  ]).flat();
  // Add global cache bars
  toolBars.push(
    { l: 'Input (all tools)', v: agg.input, c: 'var(--c-input)' },
  );
  const mxB = Math.max(...toolBars.map(b => b.v), 1);
  const grand = toolBars.reduce((s, b) => s + b.v, 0);
  $('t-bars').innerHTML = toolBars.map(b =>
    `<div class="br"><div class="bl">${b.l}</div><div class="bt"><div class="bf" style="width:${mxB ? (b.v / mxB * 100).toFixed(1) : 0}%;background:${b.c}"></div></div><div class="bv">${fmt(b.v)} <span style="color:#aaa;font-size:.7rem">(${pct(b.v, grand)})</span></div></div>`
  ).join('');

  // Token mix per session (top 20, stacked bar — show all tools)
  const top20 = sess.filter(s => (s.total_output_tokens || 0) > 0).slice(0, 20);
  if (top20.length > 0) {
    mc('c-mix', {
      type: 'bar',
      data: {
        labels: top20.map(s => `${s.tool_id?.slice(0, 3)} ${fD(s.started_at).slice(0, 8)}`),
        datasets: [
          { label: 'Cache Read', data: top20.map(s => s.total_cache_read || 0), backgroundColor: '#10b981' },
          { label: 'Cache Create', data: top20.map(s => s.total_cache_create || 0), backgroundColor: '#8b5cf6' },
          { label: 'Input', data: top20.map(s => s.total_input_tokens || 0), backgroundColor: '#3b82f6' },
          { label: 'Output', data: top20.map(s => s.total_output_tokens || 0), backgroundColor: '#f59e0b' },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { stacked: true, ticks: { maxRotation: 45, font: { size: 9 } } },
          y: { stacked: true, beginAtZero: true, ticks: { callback: v => fmt(v) } },
        },
      },
    });
  }
}

// ==============================================================
// COMPARE TOOLS TAB
// ==============================================================
async function rCompare() {
  if (!S.compare) S.compare = await fJ('/api/compare');
  const compare = S.compare || [];

  // KPIs
  const totalSess = compare.reduce((s, t) => s + (t.sessions || 0), 0);
  const totalTurns = compare.reduce((s, t) => s + (t.turns || 0), 0);
  const totalOutput = compare.reduce((s, t) => s + (t.output_tokens || 0), 0);
  $('k-compare').innerHTML = [
    kpi(fmt(totalSess), 'Total Sessions', '--primary'),
    kpi(fmt(totalTurns), 'Total Turns', '--c-input'),
    kpi(fmt(totalOutput), 'Total Output', '--c-output'),
    kpi(compare.length, 'Active Tools', '--c-cache-create'),
  ].join('');

  // Session distribution bar
  if (compare.length > 0) {
    $('compare-bar').innerHTML = `
      <div class="cb">${compare.map(t =>
        `<div class="seg" style="width:${totalSess ? (t.sessions / totalSess * 100).toFixed(1) : 0}%;background:${toolColor(t.tool_id)}" title="${t.tool_id}: ${t.sessions}"></div>`
      ).join('')}</div>
      <div class="tool-dots">${compare.map(t =>
        `<span class="tool-dot" style="background:${toolColor(t.tool_id)}"></span>${t.tool_id} (${t.sessions})`
      ).join('&nbsp;&nbsp;')}</div>`;
  }

  // Tool doughnut
  if (compare.length > 0) {
    mc('c-tool-doughnut', {
      type: 'doughnut',
      data: {
        labels: compare.map(t => t.tool_id),
        datasets: [{
          data: compare.map(t => t.sessions),
          backgroundColor: compare.map(t => toolColor(t.tool_id)),
          borderWidth: 2, borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } },
      },
    });
  }

  // Metrics comparison table
  $('compare-table').innerHTML = `<table><thead><tr>
    <th>Tool</th><th class="num">Sessions</th><th class="num">Avg Turns</th>
    <th class="num">Output/Turn</th><th class="num">Cache Hit</th><th class="num">Avg Latency</th><th>Models</th>
  </tr></thead><tbody>${compare.map(t => `<tr>
    <td>${toolChip(t.tool_id)}</td>
    <td class="num">${t.sessions}</td>
    <td class="num">${t.avg_turns_per_session != null ? Math.round(t.avg_turns_per_session) : '--'}</td>
    <td class="num">${t.avg_output_per_turn != null ? fmt(Math.round(t.avg_output_per_turn)) : '--'}</td>
    <td class="num">${t.avg_cache_pct != null ? Math.round(t.avg_cache_pct) + '%' : '--'}</td>
    <td class="num">${t.avg_latency != null ? (t.avg_latency / 1000).toFixed(1) + 's' : '--'}</td>
    <td style="font-size:.72rem;color:var(--text-s)">${(t.models || '').split(',').slice(0, 2).map(m => m.replace('claude-', '').trim()).join(', ')}</td>
  </tr>`).join('')}</tbody></table>`;
}

// ==============================================================
// CODE AUTHORSHIP TAB
// ==============================================================
let commitToolFilter = '';

async function rCommits() {
  if (!S.commits) S.commits = await fJ('/api/commits?limit=500');
  if (!S.cursorDaily) S.cursorDaily = await fJ('/api/cursor-daily');
  const allCommits = S.commits || [];
  const cursorDaily = S.cursorDaily || [];

  // Apply tool filter
  const commits = commitToolFilter
    ? allCommits.filter(c => c.tool_id === commitToolFilter)
    : allCommits;

  // KPIs
  const totalCommits = commits.length;
  const avgAi = totalCommits > 0 ? commits.reduce((s, c) => s + (c.ai_percentage || 0), 0) / totalCommits : 0;
  const totalAiLines = commits.reduce((s, c) => s + (c.ai_lines_added || 0), 0);
  const totalHumanLines = commits.reduce((s, c) => s + (c.human_lines_added || 0), 0);
  const toolCount = [...new Set(allCommits.map(c => c.tool_id))].length;
  $('k-commits').innerHTML = [
    kpi(totalCommits, 'Scored Commits', '--primary'),
    kpi(Math.round(avgAi) + '%', 'Avg AI Authorship', '--c-cache-create'),
    kpi(fmt(totalAiLines), 'AI Lines Added', '--c-cache-read'),
    kpi(fmt(totalHumanLines), 'Human Lines Added', '--c-input'),
    kpi(toolCount, 'Tools Contributing', '--c-output'),
  ].join('');

  // Cursor daily lines chart (Composer + Tab stacked)
  if (cursorDaily.length > 0) {
    const sorted = [...cursorDaily].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    mc('c-cursor-daily', {
      type: 'bar',
      data: {
        labels: sorted.map(d => (d.date || '').slice(5)),
        datasets: [
          { label: 'Composer Accepted', data: sorted.map(d => d.composer_accepted || 0), backgroundColor: '#8b5cf6' },
          { label: 'Tab Accepted', data: sorted.map(d => d.tab_accepted || 0), backgroundColor: '#06b6d4' },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { stacked: true, ticks: { maxRotation: 45, maxTicksLimit: 15 } },
          y: { stacked: true, beginAtZero: true },
        },
      },
    });
  }

  // AI authorship distribution histogram
  if (commits.length > 0) {
    const buckets = Array(10).fill(0); // 0-10, 10-20, ... 90-100
    for (const c of commits) {
      const idx = Math.min(Math.floor((c.ai_percentage || 0) / 10), 9);
      buckets[idx]++;
    }
    mc('c-ai-hist', {
      type: 'bar',
      data: {
        labels: buckets.map((_, i) => `${i * 10}-${(i + 1) * 10}%`),
        datasets: [{
          label: 'Commits',
          data: buckets,
          backgroundColor: buckets.map((_, i) => {
            const pct = (i + 0.5) * 10;
            return pct > 70 ? '#8b5cf6' : pct > 40 ? '#f59e0b' : '#3b82f6';
          }),
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 10 } } },
          y: { beginAtZero: true, title: { display: true, text: 'Commits', font: { size: 10 } } },
        },
      },
    });
  }

  // Commit scores table
  $('commit-body').innerHTML = commits.map(c => {
    const aiPct = c.ai_percentage != null ? Math.round(c.ai_percentage) : null;
    const pctColor = aiPct != null ? (aiPct > 70 ? 'var(--c-cache-create)' : aiPct > 40 ? 'var(--lv-ok)' : 'var(--text-m)') : '';
    const total = (c.ai_lines_added || 0) + (c.human_lines_added || 0);
    return `<tr>
      <td>${toolChip(c.tool_id || 'cursor')}</td>
      <td style="font-family:monospace;font-size:.76rem">${(c.commit_hash || '').slice(0, 8)}</td>
      <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.76rem">${c.branch || ''}</td>
      <td class="snip" title="${(c.commit_message || '').replace(/"/g, '&quot;')}">${c.commit_message || ''}</td>
      <td class="num" style="font-weight:700;color:${pctColor}">${aiPct != null ? aiPct + '%' : '--'}</td>
      <td class="num">${c.ai_lines_added || 0}</td>
      <td class="num">${c.human_lines_added || 0}</td>
      <td class="num">${total}</td>
    </tr>`;
  }).join('');
}

// ==============================================================
// CODE GENERATION TAB
// ==============================================================
async function rCG() {
  if (!S.codeGen) S.codeGen = await fJ('/api/code-generation');
  if (!S.insights) S.insights = await fJ('/api/insights');
  const cg = S.codeGen;
  const ins = S.insights;
  if (!cg) return;

  const { byTool, topSessions, byModel } = cg;

  // KPIs
  const totalLines = (byTool || []).reduce((s, t) => s + (t.lines_added || 0), 0);
  const totalRemoved = (byTool || []).reduce((s, t) => s + (t.lines_removed || 0), 0);
  const totalFiles = (byTool || []).reduce((s, t) => s + (t.files_touched || 0), 0);
  const faModels = (byModel || []).filter(m => m.avg_first_attempt_pct != null);
  const avgFA = faModels.length > 0
    ? faModels.reduce((s, m) => s + m.avg_first_attempt_pct, 0) / faModels.length : 0;
  const totalErrors = ins?.perTool?.reduce((s, t) => s + (t.total_errors || 0), 0) || 0;
  const recTools = (ins?.perTool || []).filter(t => t.avg_error_recovery != null);
  const avgRecovery = recTools.length > 0
    ? recTools.reduce((s, t) => s + t.avg_error_recovery, 0) / recTools.length : 0;

  $('k-cg').innerHTML = [
    kpi(fmt(totalLines), 'Lines Added', '--c-cache-read'),
    kpi(fmt(totalRemoved), 'Lines Removed', '--lv-warn'),
    kpi(fmt(totalFiles), 'Files Touched', '--c-input'),
    kpi(avgFA > 0 ? Math.round(avgFA) + '%' : '--', 'First-Attempt Success', '--lv-good'),
    kpi(fmt(totalErrors), 'Total Errors', '--lv-ok'),
    kpi(avgRecovery > 0 ? Math.round(avgRecovery) + '%' : '--', 'Error Recovery', '--c-cache-create'),
  ].join('');

  // Lines added by tool (bar chart)
  if (byTool?.length > 0) {
    mc('c-cg-bytool', {
      type: 'bar',
      data: {
        labels: byTool.map(t => t.tool_id),
        datasets: [
          { label: 'Lines Added', data: byTool.map(t => t.lines_added || 0), backgroundColor: byTool.map(t => toolColor(t.tool_id)) },
          { label: 'Lines Removed', data: byTool.map(t => t.lines_removed || 0), backgroundColor: byTool.map(t => toolColor(t.tool_id) + '60') },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: { y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } },
      },
    });
  }

  // First-attempt success by model (horizontal bar)
  if (byModel?.length > 0) {
    mc('c-cg-fa', {
      type: 'bar',
      data: {
        labels: byModel.map(m => (m.model || '').replace('claude-', '').replace(/-\d{8}$/, '')),
        datasets: [{
          label: 'First-Attempt %',
          data: byModel.map(m => m.avg_first_attempt_pct || 0),
          backgroundColor: byModel.map((_, i) => MODEL_COLORS[i % MODEL_COLORS.length]),
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
      },
    });
  }

  // Thinking depth trend
  if (ins?.trends?.thinkingDepth?.length > 0) {
    const td = ins.trends.thinkingDepth;
    mc('c-think-trend', {
      type: 'line',
      data: {
        labels: td.map(d => d.week),
        datasets: [{
          label: 'Avg Thinking Depth',
          data: td.map(d => d.avg_thinking_depth || 0),
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,0.08)',
          fill: true, tension: 0.3, pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 45, maxTicksLimit: 12, font: { size: 9 } } },
          y: { beginAtZero: true, ticks: { callback: v => fmt(v) } },
        },
      },
    });
  }

  // Error rate trend
  if (ins?.trends?.errorRate?.length > 0) {
    const er = ins.trends.errorRate;
    mc('c-error-trend', {
      type: 'line',
      data: {
        labels: er.map(d => d.week),
        datasets: [{
          label: 'Errors / Session',
          data: er.map(d => d.errors_per_session || 0),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          fill: true, tension: 0.3, pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 45, maxTicksLimit: 12, font: { size: 9 } } },
          y: { beginAtZero: true },
        },
      },
    });
  }

  // Top sessions table
  if (topSessions?.length > 0) {
    $('cg-body').innerHTML = topSessions.map(s => `<tr>
      <td>${toolChip(s.tool_id)}</td>
      <td style="white-space:nowrap">${fD(s.started_at)}</td>
      <td style="font-size:.76rem">${(s.primary_model || '').replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 16)}</td>
      <td class="num" style="color:var(--lv-good);font-weight:600">${fmt(s.code_lines_added)}</td>
      <td class="num" style="color:var(--lv-warn)">${fmt(s.code_lines_removed)}</td>
      <td class="num">${s.files_touched || 0}</td>
      <td class="num">${s.first_attempt_pct != null ? Math.round(s.first_attempt_pct) + '%' : '--'}</td>
      <td class="snip" title="${(s.title || '').replace(/"/g, '&quot;')}">${s.title || ''}</td>
    </tr>`).join('');
  }

  // Model quality comparison table
  if (ins?.modelComparison?.length > 0) {
    $('cg-model-body').innerHTML = ins.modelComparison.map(m => `<tr>
      <td style="font-weight:500;font-size:.78rem">${(m.model || '').replace('claude-', '')}</td>
      <td class="num">${m.sessions}</td>
      <td class="num">${m.avg_error_recovery != null ? Math.round(m.avg_error_recovery) + '%' : '--'}</td>
      <td class="num">${m.avg_suggestion_acceptance != null ? Math.round(m.avg_suggestion_acceptance) + '%' : '--'}</td>
      <td class="num">${m.avg_thinking_depth != null ? fmt(Math.round(m.avg_thinking_depth)) : '--'}</td>
      <td class="num">${m.avg_lint_improvement != null ? Math.round(m.avg_lint_improvement) + '%' : '--'}</td>
    </tr>`).join('');
  }
}

// ==============================================================
// COSTS TAB
// ==============================================================
async function rCosts() {
  if (!S.costs) S.costs = await fJ('/api/costs');
  const c = S.costs;
  if (!c) return;

  // KPIs
  $('k-costs').innerHTML = [
    kpi('$' + (c.totalCost || 0).toFixed(2), 'Estimated Total Cost', '--primary'),
    kpi('$' + (c.cacheSavings || 0).toFixed(2), 'Cache Savings', '--c-cache-read'),
    kpi((c.byTool || []).length, 'Tools Tracked', '--c-input'),
    kpi((c.byModel || []).length, 'Models Used', '--c-cache-create'),
  ].join('');

  // Cost by tool (doughnut)
  const bt = c.byTool || [];
  if (bt.length > 0) {
    mc('c-cost-tool', {
      type: 'doughnut',
      data: {
        labels: bt.map(t => t.tool_id),
        datasets: [{
          data: bt.map(t => t.cost || 0),
          backgroundColor: bt.map(t => toolColor(t.tool_id)),
          borderWidth: 2, borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: $${ctx.raw.toFixed(2)}` } },
        },
      },
    });
  }

  // Cost by model (bar)
  const bm = c.byModel || [];
  if (bm.length > 0) {
    mc('c-cost-model', {
      type: 'bar',
      data: {
        labels: bm.map(m => (m.model || '').replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 18)),
        datasets: [{
          label: 'Cost ($)',
          data: bm.map(m => m.cost),
          backgroundColor: bm.map((_, i) => MODEL_COLORS[i % MODEL_COLORS.length]),
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => '$' + ctx.raw.toFixed(2) } } },
        scales: {
          x: { ticks: { maxRotation: 45, font: { size: 9 } } },
          y: { beginAtZero: true, ticks: { callback: v => '$' + v.toFixed(2) } },
        },
      },
    });
  }

  // Cost breakdown table
  if (bm.length > 0) {
    $('cost-body').innerHTML = bm.map(m => `<tr>
      <td style="font-weight:500;font-size:.78rem">${(m.model || '').replace('claude-', '')}</td>
      <td class="num">${m.sessions}</td>
      <td class="num">${fmt(m.tokens)}</td>
      <td class="num" style="font-weight:600;color:var(--primary)">$${(m.cost || 0).toFixed(2)}</td>
      <td class="num">$${(m.cost_per_session || 0).toFixed(2)}</td>
    </tr>`).join('');
  }
}

// ==============================================================
// ANALYTICS TAB
// ==============================================================
async function rAna() {
  if (!S.models) S.models = await fJ('/api/models');
  if (!S.efficiency) S.efficiency = await fJ('/api/efficiency?limit=60');
  if (!S.sessions) { const r = await fJ('/api/sessions?limit=500'); if (r?.sessions) S.sessions = r.sessions; }
  const daily = await fJ('/api/daily?days=180');

  const models = S.models || [];
  const eff = S.efficiency || [];
  const sess = S.sessions || [];

  // Compute latency percentiles from sessions
  const latencies = sess.map(s => s.avg_latency_ms).filter(v => v != null && v > 0).sort((a, b) => a - b);
  const percentile = (arr, p) => arr.length > 0 ? arr[Math.floor(arr.length * p / 100)] : null;
  const p50 = percentile(latencies, 50);
  const p90 = percentile(latencies, 90);
  const p99 = percentile(latencies, 99);

  // KPIs
  $('k-ana').innerHTML = [
    kpi(p50 ? (p50 / 1000).toFixed(1) + 's' : '--', 'p50 Latency', '--c-cache-read'),
    kpi(p90 ? (p90 / 1000).toFixed(1) + 's' : '--', 'p90 Latency', '--lv-ok'),
    kpi(p99 ? (p99 / 1000).toFixed(1) + 's' : '--', 'p99 Latency', '--lv-warn'),
    kpi(models.length, 'Models Used', '--primary'),
  ].join('');

  // Model doughnut
  if (models.length > 0) {
    mc('c-model', {
      type: 'doughnut',
      data: {
        labels: models.map(m => (m.model || '').replace('claude-', '').replace(/-\d{8}$/, '')),
        datasets: [{
          data: models.map(m => m.turns || m.sessions),
          backgroundColor: models.map((_, i) => MODEL_COLORS[i % MODEL_COLORS.length]),
          borderWidth: 2, borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } },
      },
    });

    // Model table
    $('model-tbl').innerHTML = `<table><thead><tr>
      <th>Model</th><th class="num">Sessions</th><th class="num">Turns</th>
      <th class="num">Output</th><th class="num">Cache Hit</th><th class="num">Latency</th>
    </tr></thead><tbody>${models.map(m => `<tr>
      <td style="font-weight:500;font-size:.78rem">${(m.model || '').replace('claude-', '')}</td>
      <td class="num">${m.sessions}</td>
      <td class="num">${fmt(m.turns)}</td>
      <td class="num">${fmt(m.output_tokens)}</td>
      <td class="num">${m.avg_cache_pct != null ? Math.round(m.avg_cache_pct) + '%' : '--'}</td>
      <td class="num">${m.avg_latency ? (m.avg_latency / 1000).toFixed(1) + 's' : '--'}</td>
    </tr>`).join('')}</tbody></table>`;
  }

  // Turns/day line chart
  if (daily?.length > 0) {
    const dates = [...new Set(daily.map(d => d.date))].sort();
    const dailyTurns = dates.map(date =>
      daily.filter(d => d.date === date).reduce((s, d) => s + (d.total_turns || 0), 0)
    );
    mc('c-reqday', {
      type: 'line',
      data: {
        labels: dates.map(d => d.slice(5)),
        datasets: [{
          label: 'Turns',
          data: dailyTurns,
          borderColor: 'var(--primary)',
          backgroundColor: 'rgba(241,90,43,0.08)',
          fill: true, tension: 0.3, pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true },
          x: { ticks: { maxRotation: 45, maxTicksLimit: 15 } },
        },
      },
    });
  }

  // Efficiency trend
  if (eff.length > 0) {
    const sorted = [...eff].reverse();
    mc('c-efficiency', {
      type: 'line',
      data: {
        labels: sorted.map(e => (e.date || '').slice(5)),
        datasets: [{
          label: 'Value (O*Q*S)',
          data: sorted.map(e => e.value),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.08)',
          fill: true, tension: 0.3, pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true },
          x: { ticks: { maxRotation: 45, maxTicksLimit: 15 } },
        },
      },
    });
  }
}

// ==============================================================
// PERSONAL INSIGHTS TAB
// ==============================================================
async function rPersonal() {
  if (!S.personal) S.personal = await fJ('/api/personal-insights');
  const p = S.personal;
  if (!p) return;

  // ---- Hero ----
  $('pi-level-badge').textContent = p.xp.level;
  $('pi-rank').textContent = p.xp.rank;
  $('pi-xp-text').textContent = `Level ${p.xp.level} — ${fmt(p.xp.total)} / ${fmt(p.xp.nextLevelXP)} XP`;
  $('pi-xp-bar').style.width = (p.xp.progress * 100).toFixed(1) + '%';
  $('pi-streak').innerHTML = `🔥 ${p.streak.current}-day streak`;
  $('pi-longest-streak').innerHTML = `🏅 Longest: ${p.streak.longest} days`;

  // Quick stats (dark theme KPIs)
  $('pi-quick-stats').innerHTML = [
    `<div class="kc" style="border-left-color:var(--primary);background:rgba(255,255,255,.06)"><div class="kv" style="color:var(--text-on-dark)">${fmt(p.lifetime.sessions)}</div><div class="kl" style="color:rgba(255,255,255,.5)">Sessions</div></div>`,
    `<div class="kc" style="border-left-color:var(--c-cache-read);background:rgba(255,255,255,.06)"><div class="kv" style="color:var(--text-on-dark)">${fmt(p.lifetime.aiLines)}</div><div class="kl" style="color:rgba(255,255,255,.5)">AI Lines</div></div>`,
    `<div class="kc" style="border-left-color:var(--c-output);background:rgba(255,255,255,.06)"><div class="kv" style="color:var(--text-on-dark)">${fmt(p.lifetime.outputTokens)}</div><div class="kl" style="color:rgba(255,255,255,.5)">Tokens</div></div>`,
    `<div class="kc" style="border-left-color:var(--c-input);background:rgba(255,255,255,.06)"><div class="kv" style="color:var(--text-on-dark)">${p.lifetime.daysActive}</div><div class="kl" style="color:rgba(255,255,255,.5)">Days Active</div></div>`,
  ].join('');

  // ---- Weekly Challenge ----
  const ch = p.challenge;
  const chPct = ch.target > 0 ? Math.min(ch.current / ch.target, 1) : 0;
  $('pi-challenge').innerHTML = `
    <h2 style="display:flex;align-items:center;gap:8px">${ch.complete ? '✅' : '🎯'} Weekly Challenge</h2>
    <div style="font-size:.88rem;margin:8px 0;font-weight:500">${ch.title}</div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="flex:1;height:16px;background:#f0f0f0;border-radius:var(--radius-pill);overflow:hidden">
        <div style="height:100%;width:${(chPct * 100).toFixed(1)}%;background:${ch.complete ? 'var(--lv-good)' : 'var(--primary)'};border-radius:var(--radius-pill);transition:width .5s"></div>
      </div>
      <span style="font-size:.82rem;font-weight:600;min-width:80px;text-align:right">${fmt(ch.current)} / ${fmt(ch.target)}</span>
    </div>`;

  // ---- Achievements ----
  const earned = p.achievements.filter(a => a.earned);
  const locked = p.achievements.filter(a => !a.earned);
  $('pi-achievements').innerHTML =
    earned.map(a => `<div style="background:var(--primary-light);border:1px solid var(--primary);border-radius:var(--radius-sm);padding:10px 14px;text-align:center">
      <div style="font-size:1.6rem">${a.icon}</div>
      <div style="font-weight:600;font-size:.8rem;margin:4px 0">${a.title}</div>
      <div style="font-size:.7rem;color:var(--text-s)">${a.desc}</div>
    </div>`).join('') +
    locked.map(a => `<div style="background:rgba(0,0,0,.03);border:1px solid #e5e5e5;border-radius:var(--radius-sm);padding:10px 14px;text-align:center;opacity:.45">
      <div style="font-size:1.6rem;filter:grayscale(1)">🔒</div>
      <div style="font-weight:600;font-size:.8rem;margin:4px 0">${a.title}</div>
      <div style="font-size:.7rem;color:var(--text-s)">${a.desc}</div>
    </div>`).join('');

  // ---- Heatmap ----
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hMap = {};
  let maxCount = 1;
  for (const r of (p.heatmap || [])) {
    const key = `${r.dow}-${r.hour}`;
    hMap[key] = r.count;
    if (r.count > maxCount) maxCount = r.count;
  }
  const goldenSet = new Set((p.goldenHours || []).map(g => `${g.dow}-${g.hour}`));

  let hmHtml = '<table style="font-size:.7rem;border-collapse:separate;border-spacing:2px"><thead><tr><th></th>';
  for (let h = 0; h < 24; h++) hmHtml += `<th style="width:22px;text-align:center;font-weight:400;color:var(--text-s)">${h}</th>`;
  hmHtml += '</tr></thead><tbody>';
  for (let d = 0; d < 7; d++) {
    hmHtml += `<tr><td style="font-weight:500;padding-right:6px;color:var(--text-s)">${days[d]}</td>`;
    for (let h = 0; h < 24; h++) {
      const key = `${d}-${h}`;
      const cnt = hMap[key] || 0;
      const intensity = cnt > 0 ? Math.max(0.15, cnt / maxCount) : 0;
      const isGolden = goldenSet.has(key);
      const bg = cnt > 0 ? `rgba(241,90,43,${intensity.toFixed(2)})` : 'rgba(0,0,0,.03)';
      const border = isGolden ? '2px solid var(--lv-good)' : '1px solid rgba(0,0,0,.04)';
      hmHtml += `<td style="width:22px;height:22px;background:${bg};border-radius:3px;border:${border};text-align:center;cursor:default" title="${days[d]} ${h}:00 — ${cnt} sessions">${cnt > 0 ? cnt : ''}</td>`;
    }
    hmHtml += '</tr>';
  }
  hmHtml += '</tbody></table>';
  $('pi-heatmap').innerHTML = hmHtml;

  // Golden hours callout
  const gh = (p.goldenHours || []);
  if (gh.length > 0) {
    $('pi-golden').innerHTML = '⭐ <strong>Golden hours:</strong> ' + gh.map(g =>
      `${days[g.dow]} ${g.hour}:00 (${Math.round(g.avg_output_per_turn || 0)} tok/turn)`
    ).join(', ');
  }

  // ---- Flow State Trend ----
  if (p.flowTrend?.length > 0) {
    mc('c-flow-trend', {
      type: 'line',
      data: {
        labels: p.flowTrend.map(d => d.week),
        datasets: [{
          label: 'Flow Sessions',
          data: p.flowTrend.map(d => d.flow_count),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.08)',
          fill: true, tension: 0.3, pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 45, maxTicksLimit: 12, font: { size: 9 } } },
          y: { beginAtZero: true },
        },
      },
    });
  }

  // ---- Duration Sweet Spot ----
  const bucketOrder = ['0-15m', '15-30m', '30-60m', '1-2h', '2h+'];
  if (p.durationBuckets?.length > 0) {
    const sorted = bucketOrder.map(b => p.durationBuckets.find(d => d.bucket === b) || { bucket: b, count: 0, avg_quality: 0 });
    mc('c-duration-buckets', {
      type: 'bar',
      data: {
        labels: sorted.map(d => d.bucket),
        datasets: [
          { label: 'Sessions', data: sorted.map(d => d.count), backgroundColor: '#3b82f6', yAxisID: 'y' },
          { label: 'Avg Quality', data: sorted.map(d => Math.round(d.avg_quality || 0)), type: 'line', borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', yAxisID: 'y1', pointRadius: 4, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Sessions', font: { size: 9 } } },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Quality', font: { size: 9 } } },
        },
      },
    });
  }

  // ---- Deep vs Shallow Pie ----
  if (p.deepShallow?.length > 0) {
    const colors = { flow: '#10b981', normal: '#3b82f6', shallow: '#ef4444' };
    mc('c-deep-shallow', {
      type: 'doughnut',
      data: {
        labels: p.deepShallow.map(d => d.category.charAt(0).toUpperCase() + d.category.slice(1)),
        datasets: [{
          data: p.deepShallow.map(d => d.count),
          backgroundColor: p.deepShallow.map(d => colors[d.category] || '#64748b'),
          borderWidth: 2, borderColor: '#fff',
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } },
      },
    });
  }

  // ---- Tool Radar ----
  if (p.radar?.length > 0) {
    mc('c-radar', {
      type: 'radar',
      data: {
        labels: ['Output Volume', 'Cache Efficiency', 'Code Output', 'Error Recovery', 'Session Depth', 'Cost Efficiency'],
        datasets: p.radar.map(r => ({
          label: r.tool_id,
          data: [r.output, r.cache, r.code, r.recovery, r.session_depth, r.cost_efficiency],
          borderColor: toolColor(r.tool_id),
          backgroundColor: toolColor(r.tool_id) + '18',
          pointBackgroundColor: toolColor(r.tool_id),
          pointRadius: 3,
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          r: { beginAtZero: true, max: 100, ticks: { stepSize: 25, font: { size: 8 } }, pointLabels: { font: { size: 10 } } },
        },
      },
    });
  }

  // ---- Personal Records ----
  $('pi-records').innerHTML = (p.records || []).map(r => `<tr>
    <td style="font-weight:600">${r.label}</td>
    <td class="num" style="font-weight:700;color:var(--primary)">${typeof r.value === 'number' && r.value < 1000 ? (r.value % 1 === 0 ? r.value : r.value.toFixed(1)) : fmt(r.value)}</td>
    <td>${r.tool_id ? toolChip(r.tool_id) : '--'}</td>
    <td style="white-space:nowrap">${fD(r.started_at)}</td>
  </tr>`).join('');
}

// ==============================================================
// OPTIMIZATION TAB
// ==============================================================
async function rOpt() {
  if (!S.recs) S.recs = await fJ('/api/recommendations?all=true');
  const recs = S.recs || [];
  const active = recs.filter(r => !r.dismissed);
  const dismissed = recs.filter(r => r.dismissed);

  if (active.length === 0 && dismissed.length === 0) {
    $('rec-g').innerHTML = '<div style="color:var(--text-s);padding:20px">No recommendations — all looking good.</div>';
    return;
  }

  // Group by title to deduplicate repeated recommendations
  const grouped = new Map();
  for (const r of active) {
    const key = r.title;
    if (!grouped.has(key)) {
      grouped.set(key, { ...r, count: 1, metrics: [r.metric_value], ids: [r.id] });
    } else {
      const g = grouped.get(key);
      g.count++;
      g.metrics.push(r.metric_value);
      g.ids.push(r.id);
    }
  }

  // Sort: critical first, then warning, then info; within severity by count desc
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  const sorted = [...grouped.values()].sort((a, b) =>
    (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3) || b.count - a.count
  );

  // Summary KPIs
  const critCount = sorted.filter(r => r.severity === 'critical').length;
  const warnCount = sorted.filter(r => r.severity === 'warning').length;
  const infoCount = sorted.filter(r => r.severity === 'info').length;

  let html = `<div style="grid-column:1/-1;display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px">
    ${critCount > 0 ? `<div class="kc" style="border-left-color:var(--lv-warn);flex:1;min-width:120px"><div class="kv" style="color:var(--lv-warn)">${critCount}</div><div class="kl">Critical</div></div>` : ''}
    ${warnCount > 0 ? `<div class="kc" style="border-left-color:var(--lv-ok);flex:1;min-width:120px"><div class="kv" style="color:var(--lv-ok)">${warnCount}</div><div class="kl">Warnings</div></div>` : ''}
    <div class="kc" style="border-left-color:var(--lv-tip);flex:1;min-width:120px"><div class="kv" style="color:var(--lv-tip)">${infoCount}</div><div class="kl">Suggestions</div></div>
    <div class="kc" style="border-left-color:var(--text-s);flex:1;min-width:120px"><div class="kv">${dismissed.length}</div><div class="kl">Dismissed</div></div>
  </div>`;

  html += sorted.map(r => {
    const avgMetric = r.metrics.length > 0 ? Math.round(r.metrics.reduce((a, b) => a + b, 0) / r.metrics.length) : null;
    const countBadge = r.count > 1 ? `<span style="background:rgba(0,0,0,.08);border-radius:var(--radius-pill);padding:1px 7px;font-size:.68rem;margin-left:6px">${r.count}x</span>` : '';
    const metricStr = avgMetric != null ? `<span style="font-size:.72rem;color:var(--text-s);margin-left:8px">avg: ${avgMetric}${r.threshold ? ' / threshold: ' + r.threshold : ''}</span>` : '';
    return `<div class="rc ${r.severity}">
      <div class="rc-cat">${r.category}${r.tool_id ? ' — ' + r.tool_id : ''}</div>
      <div class="rc-t">${r.title}${countBadge}${metricStr}</div>
      <div class="rc-d">${r.description}</div>
      <button onclick="dismissRec([${r.ids.join(',')}])" style="margin-top:8px;border:none;background:rgba(0,0,0,.06);border-radius:var(--radius-pill);padding:4px 12px;font-size:.72rem;cursor:pointer;color:var(--text-s)">Dismiss${r.count > 1 ? ' all' : ''}</button>
    </div>`;
  }).join('');

  $('rec-g').innerHTML = html;
}

window.dismissRec = async function(ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  await Promise.all(arr.map(id => fetch(`/api/recommendations/${id}/dismiss`, { method: 'POST' })));
  S.recs = null; // force reload
  rOpt();
};

// ---- Insights Tab ----

async function rIns() {
  if (!S.insProfile) S.insProfile = await fJ('/api/insights/profile');
  if (!S.insTrends) S.insTrends = await fJ('/api/insights/trends');
  if (!S.insPrompt) S.insPrompt = await fJ('/api/insights/prompt-metrics');
  if (!S.insLlmStatus) S.insLlmStatus = await fJ('/api/ollama/status');
  rInsProfile(S.insProfile);
  rInsTrends(S.insTrends);
  rInsActions(S.insPrompt, S.insLlmStatus);
  loadDailyPick();
  bindDailyPickRefresh();
}

function rInsProfile(p) {
  if (!p) { $('ins-profile-kpi').innerHTML = '<p style="color:var(--text-s);font-size:.82rem">No data yet — run a few sessions first.</p>'; return; }
  const h12 = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  $('ins-profile-kpi').innerHTML = [
    kpi(fmt(p.medianTurns), 'Median Turns', '--primary'),
    kpi(p.medianDurationMin + 'm', 'Median Duration', '--c-output'),
    kpi(p.primaryTool || '--', 'Primary Tool', '--t-claude'),
    kpi(h12(p.peakHour || 0), 'Peak Hour', '--lv-good'),
    kpi(fmt(p.sessionCount), 'Sessions Analyzed', '--text-s'),
  ].join('');

  const breakdown = p.toolBreakdown || [];
  const max = breakdown[0]?.count || 1;
  $('ins-tool-breakdown').innerHTML = breakdown.length
    ? breakdown.map(t => `<div class="br"><div class="bl">${t.name}</div><div class="bt"><div class="bf" style="width:${t.count/max*100}%;background:var(--primary)"></div></div><div class="bv">${fmt(t.count)} <span style="color:var(--text-s);font-size:.7rem">(${t.pct}%)</span></div></div>`).join('')
    : '<p style="color:var(--text-s);font-size:.8rem">No Claude Code sessions yet.</p>';

  const b = p.firstTurnBuckets || {};
  mc('ins-first-turn-chart', {
    type: 'bar',
    data: { labels: Object.keys(b), datasets: [{ label: 'Sessions', data: Object.values(b), backgroundColor: 'rgba(241,90,43,0.7)', borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });

  $('ins-start-patterns').innerHTML = `<div class="g3">
    <div class="rc tip"><div class="rc-cat">Prompt Habit</div><div class="rc-t">${p.fileContextRate}% include file context</div><div class="rc-d">Sessions with a file path in turn 1 avg quality <strong>${p.avgQWithFile || '--'}</strong> vs <strong>${p.avgQWithoutFile || '--'}</strong> without.</div></div>
    <div class="rc tip"><div class="rc-cat">Prompt Habit</div><div class="rc-t">${p.constrainedRate}% use constraints</div><div class="rc-d">Adding scoping words (only, don't, must, avoid) in turn 1 keeps sessions more focused.</div></div>
    <div class="rc tip"><div class="rc-cat">Workflow</div><div class="rc-t">Peak hour: ${h12(p.peakHour || 0)}</div><div class="rc-d">Most sessions start around this hour — schedule complex AI work here.</div></div>
  </div>`;
}

function rInsTrends(t) {
  if (!t) return;
  const lineOpts = (color, _baseline) => ({
    type: 'line',
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 10 } } },
        y: { beginAtZero: false }
      },
      elements: { point: { radius: 0 }, line: { tension: 0.3, borderWidth: 2, borderColor: color, backgroundColor: color + '18', fill: true } }
    }
  });
  const ds = (arr, color) => ({
    labels: arr.map(r => r.date),
    datasets: [{ data: arr.map(r => r.value != null ? Math.round(r.value * 10) / 10 : null), borderColor: color, backgroundColor: color + '18', fill: true, spanGaps: true }]
  });
  mc('ins-cache-trend', { ...lineOpts('#10b981'), data: ds(t.cacheHit || [], '#10b981') });
  mc('ins-quality-trend', { ...lineOpts('#F15A2B'), data: ds(t.quality || [], '#F15A2B') });
  mc('ins-reask-trend', { ...lineOpts('#8b5cf6'), data: ds(t.reaskRate || [], '#8b5cf6') });
  mc('ins-error-trend', { ...lineOpts('#ef4444'), data: ds(t.errorRate || [], '#ef4444') });
}

const FIX_GUIDES = {
  'Poor prompt caching': 'Keep CLAUDE.md stable between sessions. Avoid volatile content at top of system prompts. Use targeted file reads rather than broad greps.',
  'Bash overuse for file reads': 'Replace <code>Bash cat file.ts</code> with the Read tool. Replace <code>Bash grep pattern</code> with Grep. These cache better.',
  'No subagent usage in long session': 'For tasks touching 3+ files, prefix: "Use parallel subagents for each file." Reduces turns and improves quality.',
  'Long session detected': 'After 100 turns, start a fresh session with a summary. Prefix: "Continuing from: [summary]".',
  'AI authorship declining': 'Review recent commits — if AI% dropped, check if prompt scope became too vague or if you\'re manually editing AI output more.',
};

function rInsActions(prompt, llmStatus) {
  const corrs = prompt?.correlations || [];
  $('ins-prompt-correlations').innerHTML = corrs.length ? `
    <h2 style="font-size:.88rem;margin-bottom:10px">Prompt Signals vs Session Quality</h2>
    <div class="rg">${corrs.map(c => {
      const diff = (c.with != null && c.without != null) ? (c.with - c.without).toFixed(1) : null;
      const col = diff > 0 ? 'var(--lv-good)' : diff < 0 ? 'var(--lv-warn)' : 'var(--text-s)';
      return `<div class="rc tip"><div class="rc-cat">Prompt Signal</div><div class="rc-t">${c.signal}</div><div class="rc-d">
        ${c.withLabel}: avg quality <strong>${c.with ?? '--'}</strong><br>
        ${c.withoutLabel}: avg quality <strong>${c.without ?? '--'}</strong>
        ${diff != null ? `<br><span style="color:${col}">${diff > 0 ? '+' : ''}${diff} pts difference</span>` : ''}
        <br><span style="color:var(--text-s)">${c.rate}% of sessions use this</span>
      </div></div>`;
    }).join('')}</div>
    ${prompt.avgTurnsToFirstEdit != null ? `<p style="font-size:.8rem;color:var(--text-s);margin-top:6px">Avg turns before first code edit: <strong>${prompt.avgTurnsToFirstEdit}</strong></p>` : ''}
  ` : '';

  const btn = $('ins-deep-btn');
  const statusEl = $('ins-llm-status');
  if (btn && statusEl) {
    if (llmStatus?.available) {
      if (!btn._streaming) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
      statusEl.textContent = `${llmStatus.provider} · ${llmStatus.model} · results cached 24h`;
    } else {
      if (!btn._streaming) { btn.disabled = true; btn.style.opacity = '0.4'; btn.style.cursor = 'not-allowed'; }
      statusEl.textContent = 'Optional: add an LLM provider in .env for AI-powered analysis';
    }
  }

  const recs = (S.recs || []).filter(r => !r.dismissed);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const grouped = {};
  for (const r of recs) { if (!grouped[r.title]) grouped[r.title] = []; grouped[r.title].push(r); }
  $('ins-recs-enhanced').innerHTML = Object.entries(grouped)
    .sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a[1][0].severity] || 2) - ({ critical: 0, warning: 1, info: 2 }[b[1][0].severity] || 2))
    .map(([title, items]) => {
      const r = items[0];
      const guide = FIX_GUIDES[title] || '';
      const sev = esc(r.severity);
      return `<div class="rc ${sev}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div><div class="rc-cat">${esc(r.category)} · ${items.length} session${items.length > 1 ? 's' : ''}</div><div class="rc-t">${esc(title)}</div></div>
          <span style="font-size:.7rem;padding:2px 7px;border-radius:var(--radius-pill);background:rgba(0,0,0,.06);color:var(--text-s);white-space:nowrap">${sev}</span>
        </div>
        <div class="rc-d" style="margin-top:6px">${esc(r.description)}</div>
        ${guide ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:.76rem;font-weight:600;color:var(--text-s)">How to fix ▸</summary><div style="margin-top:6px;font-size:.78rem;line-height:1.6;color:var(--text-m)">${guide}</div></details>` : ''}
      </div>`;
    }).join('') || '<p style="color:var(--text-s);font-size:.8rem">No active recommendations.</p>';

  // Deep Analyze streaming handler
  if (btn && !btn._deepBound) {
    btn._deepBound = true;
    btn.addEventListener('click', () => {
      const out = $('ins-deep-output');
      if (!out) return;
      out.style.display = 'block';
      out.textContent = 'Analyzing your sessions…';
      btn.disabled = true;
      btn._streaming = true;
      if (statusEl) statusEl.textContent = 'Connecting…';

      const url = btn._hasResult
        ? '/api/insights/deep-analyze?refresh=1'
        : '/api/insights/deep-analyze';
      const es = new EventSource(url);
      let fullText = '';

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.error) {
            out.textContent = data.error === 'no_provider'
              ? 'No LLM provider configured — check your server .env and restart.'
              : `Error: ${data.error}`;
            es.close();
            btn.disabled = false;
            btn._streaming = false;
            if (statusEl) statusEl.textContent = '';
            return;
          }
          if (data.token) {
            fullText += data.token;
            out.textContent = fullText;
            out.scrollTop = out.scrollHeight;
          }
          if (data.done) {
            es.close();
            btn.disabled = false;
            btn._streaming = false;
            btn._hasResult = true;
            const src = data.cached ? 'cached' : `${data.provider} · ${data.model}`;
            if (statusEl) statusEl.textContent = `Done (${src}) · cached 24h · click again to regenerate`;
            S.insLlmStatus = null; // re-fetch status on next render
          }
        } catch { /* malformed chunk */ }
      };

      es.onerror = () => {
        es.close();
        if (!fullText) out.textContent = 'Connection error — is the server running?';
        btn.disabled = false;
        btn._streaming = false;
        if (statusEl) statusEl.textContent = '';
      };
    });
  }
}

// ---- Daily Pick (Automation Recommender) ----

async function loadDailyPick() {
  const out = $('ins-daily-pick-output');
  const meta = $('ins-daily-pick-meta');
  if (!out) return;
  try {
    const d = await fJ('/api/insights/daily-pick');
    if (d.text) {
      out.textContent = d.text;
      if (meta) meta.textContent = `Generated ${d.date}${d.provider ? ' · ' + d.provider : ''}`;
    } else {
      out.textContent = 'No recommendation yet — the server will generate one shortly. Check back in a minute.';
      if (meta) meta.textContent = '';
    }
  } catch {
    if (out) out.textContent = 'Could not load daily pick.';
  }
}

function bindDailyPickRefresh() {
  const btn = $('ins-pick-refresh-btn');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', async () => {
    const out = $('ins-daily-pick-output');
    const meta = $('ins-daily-pick-meta');
    btn.disabled = true;
    if (out) out.textContent = 'Generating new recommendation…';
    try {
      await fetch('/api/insights/daily-pick/refresh', { method: 'POST' });
      // Poll until new result appears (max 60s)
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const d = await fJ('/api/insights/daily-pick');
        if (d.text) {
          clearInterval(poll);
          if (out) out.textContent = d.text;
          if (meta) meta.textContent = `Generated ${d.date}${d.provider ? ' · ' + d.provider : ''}`;
          btn.disabled = false;
        } else if (attempts > 30) {
          clearInterval(poll);
          if (out) out.textContent = 'Timed out — try again in a moment.';
          btn.disabled = false;
        }
      }, 2000);
    } catch {
      if (out) out.textContent = 'Error triggering refresh.';
      btn.disabled = false;
    }
  });
}

// ==============================================================
// PROJECTS TAB
// ==============================================================

const TOOL_COLORS_EXT = {
  'claude-code': '#d97706', cursor: '#8b5cf6', antigravity: '#06b6d4',
  aider: '#10b981', windsurf: '#6366f1', copilot: '#24292f',
};

function toolChipExt(id) {
  const colors = { 'claude-code':'claude', cursor:'cursor', antigravity:'antigravity', aider:'aider', windsurf:'windsurf', copilot:'copilot' };
  const cls = colors[id] ? `tool-${colors[id]}` : '';
  return `<span class="chip ${cls}" style="${!cls ? 'background:#f1f5f9;color:#475569' : ''}">${id}</span>`;
}

let projectsData = null;

async function rProjects() {
  if (!projectsData) {
    const r = await fJ('/api/projects');
    if (r) projectsData = r.projects || [];
  }
  const projects = projectsData || [];

  $('k-projects').innerHTML = [
    kpi(fmt(projects.length), 'Projects Tracked', '--primary'),
    kpi(fmt(projects.reduce((s, p) => s + p.session_count, 0)), 'Total Sessions', '--c-input'),
    kpi(fmt(projects.reduce((s, p) => s + p.total_tokens, 0)), 'Total Tokens', '--c-output'),
    kpi(fmt(projects.reduce((s, p) => s + p.total_lines_added, 0)), 'Lines Added', '--lv-good'),
  ].join('');

  const grid = $('projects-grid');
  if (!projects.length) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-s)">No project data yet — start a session in a project directory to see stats here.</div>';
    return;
  }

  grid.innerHTML = projects.map(p => `
    <div class="card project-card" data-project="${encodeURIComponent(p.name)}" style="cursor:pointer;transition:.15s;border-top:3px solid ${TOOL_COLORS_EXT[p.dominant_tool] || '#cbd5e1'}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
        <h3 style="font-size:.95rem;font-weight:700;color:var(--text-h)">${p.name}</h3>
        <span style="font-size:.68rem;color:var(--text-s);background:#f1f5f9;padding:2px 7px;border-radius:var(--radius-pill)">${p.session_count} session${p.session_count !== 1 ? 's' : ''}</span>
      </div>
      <div class="kpi" style="grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
        <div class="kc" style="padding:10px 12px;border-left-color:var(--c-output)"><div class="kv" style="font-size:1.1rem">${fmt(p.total_tokens)}</div><div class="kl">Tokens</div></div>
        <div class="kc" style="padding:10px 12px;border-left-color:var(--lv-good)"><div class="kv" style="font-size:1.1rem">${fmt(p.total_lines_added)}</div><div class="kl">Lines Added</div></div>
        <div class="kc" style="padding:10px 12px;border-left-color:var(--primary)"><div class="kv" style="font-size:1.1rem">${Object.keys(p.tool_breakdown || {}).length}</div><div class="kl">Tools</div></div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${Object.entries(p.tool_breakdown || {}).sort((a,b) => b[1]-a[1]).map(([t,c]) => `${toolChipExt(t)}<span style="font-size:.68rem;color:var(--text-s)">${c}</span>`).join(' ')}
      </div>
      ${p.dominant_model ? `<div style="margin-top:8px;font-size:.74rem;color:var(--text-s)">Primary model: <strong style="color:var(--text-m)">${p.dominant_model}</strong></div>` : ''}
    </div>
  `).join('');

  document.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', () => loadProjectDrilldown(decodeURIComponent(card.dataset.project)));
  });
}

async function loadProjectDrilldown(name) {
  const panel = $('project-drilldown');
  const content = $('drilldown-content');
  $('drilldown-title').textContent = name;
  panel.style.display = 'block';
  content.innerHTML = '<span style="color:var(--text-s)">Loading insights...</span>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const data = await fJ(`/api/projects/${encodeURIComponent(name)}/insights`);
  if (!data) {
    content.innerHTML = '<span style="color:var(--lv-warn)">Failed to load insights.</span>';
    return;
  }

  const stats = data.tool_model_stats || [];
  content.innerHTML = `
    <div class="kpi" style="margin-bottom:14px">
      <div class="kc" style="border-left-color:var(--primary)"><div class="kv">${fmt(data.total_tokens)}</div><div class="kl">Total Tokens</div></div>
      <div class="kc" style="border-left-color:var(--lv-good)"><div class="kv">${fmt(data.total_lines_added)}</div><div class="kl">Lines Added</div></div>
      <div class="kc" style="border-left-color:var(--c-input)"><div class="kv">${data.session_count}</div><div class="kl">Sessions</div></div>
      <div class="kc" style="border-left-color:var(--c-output)"><div class="kv">${data.dominant_model || '—'}</div><div class="kl">Primary Model</div></div>
    </div>
    ${stats.length ? `
    <h3 style="font-size:.86rem;font-weight:600;margin-bottom:10px;color:var(--text-s)">Tool + Model Performance (sorted by avg turns)</h3>
    <div style="overflow-x:auto"><table><thead><tr>
      <th>Tool</th><th>Model</th><th class="num">Sessions</th><th class="num">Avg Turns</th><th class="num">Cache Hit</th><th class="num">Quality</th>
    </tr></thead><tbody>
      ${stats.map(s => `<tr>
        <td>${toolChipExt(s.tool)}</td>
        <td style="font-size:.78rem">${s.model || '—'}</td>
        <td class="num">${s.sessions}</td>
        <td class="num">${(s.avg_turns || 0).toFixed(1)}</td>
        <td class="num">${(s.avg_cache_hit || 0).toFixed(1)}%</td>
        <td class="num">${Math.round(s.avg_quality || 0)}</td>
      </tr>`).join('')}
    </tbody></table></div>` : ''}
    ${data.suggestions ? `
    <div style="margin-top:14px;background:#f8f9fa;border-radius:var(--radius-sm);padding:14px;font-size:.82rem;line-height:1.7;border:1px solid #e5e7eb">
      <strong style="font-size:.8rem;text-transform:uppercase;letter-spacing:.5px;color:var(--text-s)">AI Suggestions</strong>
      <div style="margin-top:8px;white-space:pre-wrap">${data.suggestions}</div>
    </div>` : ''}
  `;

  $('drilldown-close').onclick = () => {
    panel.style.display = 'none';
  };
}

// ==============================================================
// MODELS TAB
// ==============================================================

let modelsData = null;
let winRatesData = null;

async function rModels() {
  if (!modelsData || !winRatesData) {
    [modelsData, winRatesData] = await Promise.all([
      fJ('/api/models/performance'),
      fJ('/api/routing/win-rates'),
    ]);
  }

  const models = modelsData?.models || [];
  const winRates = winRatesData?.win_rates || [];

  // KPIs
  const totalSessions = models.reduce((s, m) => s + m.sessions, 0);
  const avgLatency = models.filter(m => m.avg_latency_ms).reduce((s, m, _, a) => s + m.avg_latency_ms / a.length, 0);
  $('k-models').innerHTML = [
    kpi(models.length, 'Models Tracked', '--primary'),
    kpi(fmt(totalSessions), 'Total Sessions', '--c-input'),
    kpi(winRates.length, 'Task Type Combos', '--c-cache-read'),
    kpi(avgLatency > 0 ? Math.round(avgLatency) + 'ms' : '--', 'Avg Latency', '--c-output'),
  ].join('');

  // Model performance table
  const perfBody = $('models-perf-body');
  if (!models.length) {
    perfBody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-s)">No model performance data yet. Complete more sessions to see stats.</td></tr>';
  } else {
    perfBody.innerHTML = models.map(m => `<tr>
      <td><strong>${m.model}</strong></td>
      <td style="font-size:.75rem">${(m.tools || []).map(t => toolChipExt(t)).join('')}</td>
      <td class="num">${m.sessions}</td>
      <td class="num">${(m.avg_turns || 0).toFixed(1)}</td>
      <td class="num">${(m.cache_hit_pct || 0).toFixed(1)}%</td>
      <td class="num">${m.avg_latency_ms ? Math.round(m.avg_latency_ms) + 'ms' : '—'}</td>
      <td class="num" style="color:${(m.error_rate || 0) > 0.1 ? 'var(--lv-warn)' : 'var(--text-m)'}">${((m.error_rate || 0) * 100).toFixed(1)}%</td>
    </tr>`).join('');
  }

  // Win rates table
  const wrBody = $('models-winrate-body');
  if (!winRates.length) {
    wrBody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-s)">Not enough data yet. Need 2+ sessions per tool/model/task combination.</td></tr>';
  } else {
    wrBody.innerHTML = winRates.slice(0, 25).map(r => `<tr>
      <td>${toolChipExt(r.tool_id)}</td>
      <td style="font-size:.78rem">${r.model}</td>
      <td><span style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:.72rem">${r.task_type}</span></td>
      <td class="num"><strong style="color:${r.win_rate >= 70 ? 'var(--lv-good)' : r.win_rate >= 40 ? 'var(--lv-ok)' : 'var(--text-m)'}">${r.win_rate}%</strong></td>
      <td class="num">${(r.avg_turns || 0).toFixed(1)}</td>
      <td class="num">${r.sessions}</td>
    </tr>`).join('');
  }

  // Routing recommendation button
  $('routing-btn').onclick = async () => {
    const task = $('routing-task-input').value.trim();
    if (!task) return;
    const result = $('routing-result');
    result.innerHTML = '<span style="color:var(--text-s)">Analyzing your historical data...</span>';
    const data = await fJ(`/api/routing/recommend?task=${encodeURIComponent(task)}`);
    if (!data) { result.innerHTML = '<span style="color:var(--lv-warn)">Failed to get recommendation.</span>'; return; }
    if (data.recommendation) {
      result.innerHTML = `
        <div style="background:var(--lv-good-bg);border-left:4px solid var(--lv-good);padding:12px 16px;border-radius:var(--radius-sm);margin-bottom:10px">
          <strong style="font-size:.9rem">Use: ${toolChipExt(data.recommendation.tool)} with <strong>${data.recommendation.model}</strong></strong>
          <p style="margin-top:6px;color:var(--text-m)">${data.reason}</p>
        </div>
        ${data.win_rates?.length ? `<div style="font-size:.78rem;color:var(--text-s);margin-top:8px">
          <strong>Top alternatives:</strong><br>
          ${data.win_rates.slice(1, 5).map(r => `${toolChipExt(r.tool_id)} ${r.model} — ${r.win_rate}% win rate, avg ${r.avg_turns?.toFixed(1)} turns`).join('<br>')}
        </div>` : ''}
      `;
    } else {
      result.innerHTML = `<div style="background:#f8f9fa;padding:12px 16px;border-radius:var(--radius-sm);color:var(--text-m)">${data.reason}</div>`;
    }
  };

  $('routing-task-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('routing-btn').click(); });
}

// ---- PWA ----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSSE();
  checkForUpdate();
  refreshAll();
  setInterval(refreshAll, 30000);

  // Issue banner buttons
  const ibc = $('ib-close');
  if (ibc) ibc.onclick = () => { bannerDismissed = true; const b = $('issue-banner'); if(b) b.className = ''; };
  const ibl = $('ib-link');
  if (ibl) ibl.onclick = () => onTab('insights');

  // Session controls
  $('s-search').addEventListener('input', e => { sFilt = e.target.value; rSess(); });
  $('s-sort').addEventListener('change', e => { sSort = e.target.value; rSess(); });
  $('s-tool').addEventListener('change', e => { sTool = e.target.value; rSess(); });

  // Overview date range
  $('ov-range').addEventListener('change', e => { ovRange = parseInt(e.target.value); rOv(); });

  // Commit tool filter
  $('commit-tool-filter').addEventListener('change', e => { commitToolFilter = e.target.value; rCommits(); });
});

// ═══════════════════════════════════════════════════════════════
// 4-PILLAR NAVIGATION SYSTEM
// ═══════════════════════════════════════════════════════════════

// ---- Modal System ----
function openModal(title, contentHtml) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box">
        <button class="modal-close" onclick="closeModal()">&#x2715;</button>
        <div class="modal-title">${title}</div>
        <div id="modal-content">${contentHtml}</div>
      </div>
    </div>`;
  document.addEventListener('keydown', _modalEsc);
}
function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  document.removeEventListener('keydown', _modalEsc);
}
function _modalEsc(e) { if (e.key === 'Escape') closeModal(); }

// ---- Drawer System ----
function openDrawer(title, contentHtml) {
  const root = document.getElementById('drawer-root');
  if (!root) return;
  root.innerHTML = `
    <div class="drawer-backdrop" onclick="closeDrawer()"></div>
    <div class="drawer-panel">
      <div class="drawer-header">
        <span class="drawer-title">${title}</span>
        <button class="drawer-close" onclick="closeDrawer()">&#x2715;</button>
      </div>
      <div id="drawer-content">${contentHtml}</div>
    </div>`;
  document.addEventListener('keydown', _drawerEsc);
}
function closeDrawer() {
  const root = document.getElementById('drawer-root');
  if (root) root.innerHTML = '';
  document.removeEventListener('keydown', _drawerEsc);
}
function _drawerEsc(e) { if (e.key === 'Escape') closeDrawer(); }

// ---- Command Palette ----
let _cmdkOpen = false;

function openCmdK() {
  if (_cmdkOpen) return;
  _cmdkOpen = true;
  const root = document.getElementById('cmdk-root');
  if (!root) return;
  root.innerHTML = `
    <div class="cmdk-backdrop" id="cmdk-backdrop" onclick="if(event.target===this)closeCmdK()">
      <div class="cmdk-box">
        <input class="cmdk-input" id="cmdk-input" placeholder="Search sessions, projects, navigate\u2026" autocomplete="off">
        <div class="cmdk-results" id="cmdk-results"></div>
      </div>
    </div>`;
  const input = document.getElementById('cmdk-input');
  input.focus();
  input.addEventListener('input', _cmdkSearch);
  input.addEventListener('keydown', _cmdkNav);
  document.addEventListener('keydown', _cmdkEsc);
  _cmdkSearch();
}

function closeCmdK() {
  _cmdkOpen = false;
  const root = document.getElementById('cmdk-root');
  if (root) root.innerHTML = '';
  document.removeEventListener('keydown', _cmdkEsc);
}

function _cmdkEsc(e) { if (e.key === 'Escape') closeCmdK(); }

function _cmdkSearch() {
  const q = (document.getElementById('cmdk-input')?.value || '').toLowerCase().trim();
  const results = document.getElementById('cmdk-results');
  if (!results) return;

  const navItems = [
    { icon: '\uD83C\uDFE0', label: 'Command Center', sub: 'KPIs, recommendations, insights', pillar: 'command' },
    { icon: '\uD83D\uDCC1', label: 'Workspaces', sub: 'Projects and sessions', pillar: 'workspaces' },
    { icon: '\uD83D\uDCCA', label: 'Performance', sub: 'Tools, models, code gen', pillar: 'performance' },
    { icon: '\uD83D\uDC64', label: 'Profile', sub: 'Level, costs, efficiency', pillar: 'profile' },
  ];

  const sessions = (S.sessions || []).slice(0, 200);
  const sessionItems = sessions
    .filter(s => !q || (s.tool_id + ' ' + (s.label || '') + ' ' + (s.project_name || '')).toLowerCase().includes(q))
    .slice(0, 6)
    .map(s => ({
      icon: '\uD83D\uDCAC',
      label: s.label || ('Session ' + (s.id || '').slice(0, 8)),
      sub: s.tool_id + ' \u00B7 ' + fD(s.started_at) + ' \u00B7 ' + s.total_turns + ' turns',
      pillar: 'workspaces'
    }));

  const navFiltered = navItems.filter(n => !q || n.label.toLowerCase().includes(q) || n.sub.toLowerCase().includes(q));

  if (!navFiltered.length && !sessionItems.length) {
    results.innerHTML = '<div class="cmdk-empty">No results for &ldquo;' + q + '&rdquo;</div>';
    return;
  }

  let html = '';
  if (navFiltered.length) {
    html += '<div class="cmdk-section-label">Navigate</div>';
    html += navFiltered.map(n => `
      <div class="cmdk-item" data-pillar="${n.pillar}" onclick="switchPillar('${n.pillar}');closeCmdK()">
        <div class="cmdk-item-icon" style="background:rgba(241,90,43,0.1)">${n.icon}</div>
        <div><div class="cmdk-item-label">${n.label}</div><div class="cmdk-item-sub">${n.sub}</div></div>
      </div>`).join('');
  }
  if (sessionItems.length) {
    html += '<div class="cmdk-section-label">Sessions</div>';
    html += sessionItems.map(n => `
      <div class="cmdk-item" onclick="switchPillar('workspaces');closeCmdK()">
        <div class="cmdk-item-icon" style="background:rgba(59,130,246,0.1)">${n.icon}</div>
        <div><div class="cmdk-item-label">${n.label}</div><div class="cmdk-item-sub">${n.sub}</div></div>
      </div>`).join('');
  }
  results.innerHTML = html;
}

function _cmdkNav(e) {
  if (e.key === 'Enter') {
    const first = document.querySelector('.cmdk-item');
    if (first) first.click();
  }
}

// ---- Pillar Navigation ----
let _currentPillar = 'command';

function switchPillar(name) {
  _currentPillar = name;
  // Update desktop nav
  document.querySelectorAll('.pillar-btn').forEach(b => b.classList.toggle('active', b.dataset.pillar === name));
  // Update mobile nav
  document.querySelectorAll('.pillar-bottom-btn').forEach(b => b.classList.toggle('active', b.dataset.pillar === name));
  // Show/hide sections
  document.querySelectorAll('.pillar-section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('p-' + name);
  if (target) target.classList.add('active');
  // Render content
  renderPillar(name);
}

async function renderPillar(name) {
  if (name === 'command') {
    await renderCommandCenter();
  } else if (name === 'workspaces') {
    initSubTabs('p-workspaces', _subTabRenderers.workspaces);
    _mountV2Tab('t-sessions', 'ws-sessions');
    rSess();
  } else if (name === 'performance') {
    initSubTabs('p-performance', _subTabRenderers.performance);
    _mountV2Tab('t-compare', 'perf-tools');
    rCompare();
  } else if (name === 'profile') {
    initSubTabs('p-profile', _subTabRenderers.profile);
    _subTabRenderers.profile['prof-personal']();
  }
}

// Sub-tab renderer map — maps panel IDs to the V2 render function to call.
// V2 renderers write into #t-sessions, #t-tokens etc. which still exist in HTML (just hidden).
// We move the #t-* element into the active sub-panel so the renderer output is visible.
const _subTabRenderers = {
  workspaces: {
    'ws-sessions': () => { _mountV2Tab('t-sessions', 'ws-sessions'); rSess(); },
    'ws-projects': () => { _mountV2Tab('t-projects', 'ws-projects'); rProjects(); },
    'ws-tokens':   () => { _mountV2Tab('t-tokens', 'ws-tokens'); rTok(); },
  },
  performance: {
    'perf-tools':     () => { _mountV2Tab('t-compare', 'perf-tools'); rCompare(); },
    'perf-models':    () => { _mountV2Tab('t-models', 'perf-models'); rModels(); },
    'perf-codegen':   () => { _mountV2Tab('t-codegen', 'perf-codegen'); rCG(); },
    'perf-cursor':    () => renderCursorDeepDive(),
    'perf-analytics': () => { _mountV2Tab('t-analytics', 'perf-analytics'); rAna(); },
  },
  profile: {
    'prof-personal': () => renderProfilePillar(),
    'prof-costs':    () => { _mountV2Tab('t-costs', 'prof-costs'); rCosts(); },
    'prof-insights': () => renderCombinedInsights(),
  },
};

// Move a hidden V2 .tp element into the target sub-panel div (only once)
// Returns a promise that resolves after the element is in the DOM and laid out
function _mountV2Tab(v2Id, panelId) {
  const panel = document.getElementById(panelId);
  const v2el = document.getElementById(v2Id);
  if (!panel || !v2el) return;
  if (!panel.contains(v2el)) {
    v2el.style.display = 'block';
    v2el.style.padding = '16px 24px 40px';
    panel.appendChild(v2el);
  } else {
    v2el.style.display = 'block';
  }
  // After a layout tick, resize any charts that were created while hidden
  requestAnimationFrame(() => {
    Object.values(S.charts || {}).forEach(chart => {
      try { chart.resize(); } catch { /* ignore */ }
    });
  });
}

// Wire sub-tab clicking for a pillar section
function initSubTabs(sectionId, renderers) {
  const section = document.getElementById(sectionId);
  if (!section || section.dataset.subTabsInit) return;
  section.dataset.subTabsInit = '1';
  section.querySelectorAll('.sub-tab').forEach(btn => {
    btn.onclick = async () => {
      const panelId = btn.dataset.stab;
      section.querySelectorAll('.sub-tab').forEach(b => b.classList.toggle('active', b === btn));
      section.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.toggle('active', p.id === panelId));
      if (renderers[panelId]) await renderers[panelId]();
    };
  });
}

// ---- Savings Report Card ----
function renderSavingsCard(data) {
  if (!data || !data.relative || data.relative.total_sessions === 0) {
    return `<div class="card" style="margin:0">
      <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Savings Report</h2>
      <div style="color:var(--text-s);font-size:.84rem">Not enough data yet. Complete more sessions to see savings.</div>
    </div>`;
  }
  const r = data.relative;
  const d = data.dollars;
  const t = data.time;
  const fmtD = v => v != null ? '$' + (v >= 100 ? Math.round(v) : v.toFixed(2)) : '--';
  return `<div class="card" style="margin:0">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin:0">Savings Report</h2>
      <label style="font-size:.72rem;color:var(--text-s);display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" id="savings-dollar-toggle" style="accent-color:var(--primary)"> Show $
      </label>
    </div>
    <div id="savings-relative">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="padding:8px 12px;border-radius:8px;background:rgba(34,197,94,0.06)">
          <div style="font-size:1.1rem;font-weight:800;color:#16a34a">${r.cache_savings_pct}%</div>
          <div style="font-size:.72rem;color:var(--text-s)">Cache savings</div>
        </div>
        <div style="padding:8px 12px;border-radius:8px;background:rgba(59,130,246,0.06)">
          <div style="font-size:1.1rem;font-weight:800;color:#2563eb">${r.error_recovery_rate}%</div>
          <div style="font-size:.72rem;color:var(--text-s)">Error recovery</div>
        </div>
        <div style="padding:8px 12px;border-radius:8px;background:rgba(139,92,246,0.06)">
          <div style="font-size:1.1rem;font-weight:800;color:#7c3aed">${r.routing_adherence_pct}%</div>
          <div style="font-size:.72rem;color:var(--text-s)">Routing adherence</div>
        </div>
        <div style="padding:8px 12px;border-radius:8px;background:rgba(245,158,11,0.06)">
          <div style="font-size:1.1rem;font-weight:800;color:#d97706">${t.estimated_hours_saved}h</div>
          <div style="font-size:.72rem;color:var(--text-s)">Hours saved</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:.74rem;color:var(--text-s)">${r.sessions_optimized} of ${r.total_sessions} sessions optimized (quality &gt; 70)</div>
    </div>
    <div id="savings-dollars" style="display:none">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="padding:8px 12px;border-radius:8px;background:rgba(34,197,94,0.06)">
          <div style="font-size:1.1rem;font-weight:800;color:#16a34a">${fmtD(d.cache_savings_dollars)}</div>
          <div style="font-size:.72rem;color:var(--text-s)">Cache savings</div>
        </div>
        <div style="padding:8px 12px;border-radius:8px;background:rgba(59,130,246,0.06)">
          <div style="font-size:1.1rem;font-weight:800;color:#2563eb">${fmtD(d.efficient_session_savings)}</div>
          <div style="font-size:.72rem;color:var(--text-s)">Efficiency savings</div>
        </div>
        <div style="padding:8px 12px;border-radius:8px;background:rgba(245,158,11,0.06);grid-column:1/-1">
          <div style="font-size:1.1rem;font-weight:800;color:#d97706">${fmtD(d.total_estimated_cost)}</div>
          <div style="font-size:.72rem;color:var(--text-s)">Total estimated spend</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:.68rem;color:var(--text-s);font-style:italic">${esc(d.disclaimer)}</div>
    </div>
  </div>`;
}

// ---- Import Session Modal ----
function showImportModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div id="import-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--bg-card,#fff);border-radius:12px;padding:28px 32px;max-width:560px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
          <h2 style="margin:0;font-size:1.1rem;font-weight:700;color:var(--text-h)">Import Session</h2>
          <button id="import-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-s);line-height:1">&times;</button>
        </div>

        <div style="margin-bottom:16px">
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="import-tab-btn active" data-itab="paste" style="flex:1;padding:8px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--primary);color:#fff;cursor:pointer;font-size:.82rem;font-weight:600">Paste JSON</button>
            <button class="import-tab-btn" data-itab="upload" style="flex:1;padding:8px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:none;color:var(--text-m);cursor:pointer;font-size:.82rem">Upload File</button>
          </div>
        </div>

        <div id="import-paste-panel">
          <textarea id="import-json" placeholder='{"tool":"chatgpt","title":"My Session","turns":[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi!"}]}' style="width:100%;min-height:180px;padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:8px;font-family:var(--font-mono,'DM Mono',monospace);font-size:.78rem;resize:vertical;background:var(--bg-alt,#f8f8f8);color:var(--text-m)"></textarea>
        </div>

        <div id="import-upload-panel" style="display:none">
          <div style="border:2px dashed var(--border,#e5e7eb);border-radius:8px;padding:32px;text-align:center;cursor:pointer" id="import-drop-zone">
            <div style="font-size:2rem;margin-bottom:8px">📁</div>
            <div style="font-size:.84rem;color:var(--text-s)">Drop a JSON file here or <label for="import-file" style="color:var(--primary);cursor:pointer;text-decoration:underline">browse</label></div>
            <input type="file" id="import-file" accept=".json" style="display:none">
          </div>
        </div>

        <div id="import-status" style="margin-top:12px;font-size:.82rem;display:none;padding:10px 14px;border-radius:8px"></div>

        <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
          <button id="import-cancel" style="padding:8px 18px;border:1px solid var(--border,#e5e7eb);border-radius:var(--radius-pill);background:none;color:var(--text-m);cursor:pointer;font-size:.82rem">Cancel</button>
          <button id="import-submit" style="padding:8px 18px;border:none;border-radius:var(--radius-pill);background:var(--primary);color:#fff;cursor:pointer;font-size:.82rem;font-weight:600">Import</button>
        </div>

        <details style="margin-top:16px">
          <summary style="font-size:.76rem;color:var(--text-s);cursor:pointer">Schema reference</summary>
          <pre style="font-size:.7rem;background:var(--bg-alt,#f8f8f8);padding:10px;border-radius:6px;overflow-x:auto;margin-top:8px;color:var(--text-m)">{
  "tool": "chatgpt|claude-web|gemini-web|custom",
  "title": "Session Title (optional)",
  "started_at": "2025-01-01T12:00:00Z (optional)",
  "model": "gpt-4o (optional)",
  "turns": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}</pre>
        </details>
      </div>
    </div>`;

  // Wire up events
  root.querySelector('#import-close').onclick = () => { root.innerHTML = ''; };
  root.querySelector('#import-cancel').onclick = () => { root.innerHTML = ''; };
  root.querySelector('#import-modal-overlay').onclick = (e) => { if (e.target.id === 'import-modal-overlay') root.innerHTML = ''; };

  // Tab switching
  root.querySelectorAll('.import-tab-btn').forEach(btn => {
    btn.onclick = () => {
      root.querySelectorAll('.import-tab-btn').forEach(b => { b.style.background = 'none'; b.style.color = 'var(--text-m)'; });
      btn.style.background = 'var(--primary)'; btn.style.color = '#fff';
      const tab = btn.dataset.itab;
      root.querySelector('#import-paste-panel').style.display = tab === 'paste' ? '' : 'none';
      root.querySelector('#import-upload-panel').style.display = tab === 'upload' ? '' : 'none';
    };
  });

  // File upload
  const fileInput = root.querySelector('#import-file');
  const dropZone = root.querySelector('#import-drop-zone');
  dropZone.onclick = () => fileInput.click();
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; };
  dropZone.ondragleave = () => { dropZone.style.borderColor = 'var(--border,#e5e7eb)'; };
  dropZone.ondrop = (e) => {
    e.preventDefault(); dropZone.style.borderColor = 'var(--border,#e5e7eb)';
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  };
  fileInput.onchange = () => { if (fileInput.files.length) loadFile(fileInput.files[0]); };

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => { root.querySelector('#import-json').value = reader.result; showStatus('File loaded: ' + file.name, false); };
    reader.readAsText(file);
    // Switch to paste tab to show content
    root.querySelectorAll('.import-tab-btn').forEach(b => { b.style.background = 'none'; b.style.color = 'var(--text-m)'; });
    root.querySelector('[data-itab="paste"]').style.background = 'var(--primary)';
    root.querySelector('[data-itab="paste"]').style.color = '#fff';
    root.querySelector('#import-paste-panel').style.display = '';
    root.querySelector('#import-upload-panel').style.display = 'none';
  }

  function showStatus(msg, isError) {
    const st = root.querySelector('#import-status');
    st.style.display = '';
    st.style.background = isError ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)';
    st.style.color = isError ? '#dc2626' : '#16a34a';
    st.textContent = msg;
  }

  // Submit
  root.querySelector('#import-submit').onclick = async () => {
    const raw = root.querySelector('#import-json').value.trim();
    if (!raw) { showStatus('Please paste or upload session JSON.', true); return; }
    let data;
    try { data = JSON.parse(raw); } catch { showStatus('Invalid JSON. Check your input.', true); return; }
    if (!data.turns || !data.turns.length) { showStatus('JSON must include a "turns" array.', true); return; }

    try {
      const resp = await fetch('/api/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await resp.json();
      if (result.ok) {
        showStatus(`Imported ${result.turns} turns as session ${result.session_id.slice(0, 8)}...`, false);
        setTimeout(() => { root.innerHTML = ''; refreshAll(); }, 1500);
      } else {
        showStatus('Import failed: ' + (result.error || 'Unknown error'), true);
      }
    } catch (e) {
      showStatus('Network error: ' + e.message, true);
    }
  };
}

// ---- Bookmarklet Modal ----
function showBookmarkletModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div id="bm-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--bg-card,#fff);border-radius:12px;padding:28px 32px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
          <h2 style="margin:0;font-size:1.1rem;font-weight:700;color:var(--text-h)">Browser Bookmarklet</h2>
          <button id="bm-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-s);line-height:1">&times;</button>
        </div>
        <p style="font-size:.84rem;color:var(--text-m);line-height:1.6;margin-bottom:14px">
          Drag this button to your bookmarks bar. Click it on any ChatGPT, Claude.ai, or Gemini page to capture the conversation.
        </p>
        <div style="text-align:center;padding:20px;background:var(--bg-alt,#f8f8f8);border-radius:8px;margin-bottom:14px">
          <a id="bm-link" href="#" style="display:inline-block;padding:10px 24px;background:var(--primary);color:#fff;border-radius:var(--radius-pill);font-weight:700;font-size:.9rem;text-decoration:none;cursor:grab">Capture AI Session</a>
        </div>
        <ol style="font-size:.78rem;color:var(--text-s);line-height:1.8;padding-left:20px;margin:0">
          <li>Drag the button above to your bookmarks bar</li>
          <li>Open a ChatGPT, Claude.ai, or Gemini conversation</li>
          <li>Click the bookmarklet to capture the session</li>
          <li>Sessions appear in your dashboard automatically</li>
        </ol>
      </div>
    </div>`;

  root.querySelector('#bm-close').onclick = () => { root.innerHTML = ''; };
  root.querySelector('#bm-modal-overlay').onclick = (e) => { if (e.target.id === 'bm-modal-overlay') root.innerHTML = ''; };

  // Fetch bookmarklet code
  fJ('/api/bookmarklet').then(data => {
    if (data && data.code) {
      root.querySelector('#bm-link').href = data.code;
    }
  });
}

// ---- Command Center ----
async function renderCommandCenter() {
  const el = document.getElementById('p-command-inner');
  if (!el) return;

  const [ovRes, recsRes, profileRes, costsRes, codeGenRes, agenticRes, savingsRes] = await Promise.all([
    S.overview ? S.overview : fJ('/api/overview'),
    S.recs ? S.recs : fJ('/api/recommendations'),
    S.insProfile ? S.insProfile : fJ('/api/insights/profile'),
    S.costs ? S.costs : fJ('/api/costs'),
    S.codeGen ? S.codeGen : fJ('/api/code-generation'),
    fJ('/api/agentic/scores'),
    fJ('/api/savings-report'),
  ]);
  S.overview = ovRes; S.recs = recsRes; S.insProfile = profileRes;
  S.costs = costsRes; S.codeGen = codeGenRes;

  const ov = S.overview || {};
  const g = ov.global || {};
  const recs = (S.recs || []).filter(r => !r.dismissed).slice(0, 4);
  const profile = S.insProfile || {};
  const tools = ov.tools || [];
  const today = ov.today || [];
  const commits = ov.commits || {};
  const agentic = agenticRes?.leaderboard || [];

  // Compute totals
  const totalSessions = g.total_sessions || 0;
  const totalTurns = g.total_turns || 0;
  const totalTokens = (g.total_input || 0) + (g.total_output || 0);
  const avgCache = g.avg_cache_pct;
  const totalCost = g.total_cost;
  const totalCodeLines = g.total_code_lines || 0;
  const totalFiles = g.total_files_touched || 0;
  const avgAgentic = g.avg_agentic_score;
  const distinctModels = g.distinct_models || 0;
  const activeDays = g.active_days || 0;
  const avgThinking = g.avg_thinking_depth;
  const avgErrorRecovery = g.avg_error_recovery;

  const avgQuality = tools.length
    ? tools.reduce((s, t) => s + (t.avg_quality || 0), 0) / tools.length
    : null;

  const todayTurns = today.reduce((s, t) => s + (t.turns || t.count || 0), 0);
  const todaySessions = today.reduce((s, t) => s + (t.count || 0), 0);

  const hour12 = h => h != null ? (h % 12 || 12) + (h < 12 ? 'am' : 'pm') : '--';
  const fmtCost = c => c != null ? '$' + (c >= 100 ? Math.round(c) : c.toFixed(2)) : '--';

  // Top agentic sessions
  const topAgentic = agentic.slice(0, 3);

  // Empty state for new users with no data
  if (totalSessions === 0) {
    el.innerHTML = `
      <div style="text-align:center;padding:60px 24px;max-width:600px;margin:0 auto">
        <div style="font-size:3rem;margin-bottom:16px">🚀</div>
        <h2 style="font-size:1.4rem;font-weight:700;color:var(--text-h);margin-bottom:12px">Welcome to AI Productivity Dashboard</h2>
        <p style="color:var(--text-s);font-size:.92rem;line-height:1.7;margin-bottom:24px">
          No sessions detected yet. The dashboard auto-discovers data from your AI coding tools.
          Start a session in any supported tool and it will appear here automatically.
        </p>
        <div style="text-align:left;background:var(--bg-alt,#f8f8f8);border-radius:12px;padding:20px 24px;margin-bottom:20px">
          <h3 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Supported Tools</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.84rem">
            <div>✅ Claude Code</div><div>✅ Cursor</div>
            <div>✅ Aider</div><div>✅ Windsurf</div>
            <div>✅ GitHub Copilot</div><div>✅ Continue.dev</div>
            <div>✅ Gemini / Antigravity</div><div></div>
          </div>
        </div>
        <div style="text-align:left;background:var(--bg-alt,#f8f8f8);border-radius:12px;padding:20px 24px;margin-bottom:20px">
          <h3 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Quick Start</h3>
          <ol style="font-size:.84rem;color:var(--text-m);line-height:1.8;padding-left:20px;margin:0">
            <li>Use any supported AI coding tool (Claude Code, Cursor, etc.)</li>
            <li>The dashboard scans for session data every 60 seconds</li>
            <li>Check the terminal for the auto-discovery report showing detected tools</li>
          </ol>
        </div>
        <p style="font-size:.78rem;color:var(--text-s)">
          Need help? See <a href="https://github.com/Riko5652/ai-productivity-dashboard/blob/main/SETUP.md" target="_blank" style="color:var(--primary);text-decoration:none;font-weight:600">SETUP.md</a> for path overrides and troubleshooting.
        </p>
      </div>`;
    return;
  }

  // Gamification data
  const xp = profile.xp || {};
  const streak = profile.streak || {};

  el.innerHTML = `
    <!-- Gamification banner -->
    ${xp.level != null ? `
    <div style="display:flex;align-items:center;gap:14px;padding:10px 16px;margin-bottom:14px;border-radius:10px;background:linear-gradient(90deg,rgba(99,102,241,0.06),rgba(245,158,11,0.04));border:1px solid rgba(99,102,241,0.1);font-size:.78rem;color:var(--text-s)">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:1rem;font-weight:800;color:var(--primary);font-family:var(--font-mono,'DM Mono',monospace)">Lv.${xp.level}</span>
        <span style="opacity:.7">${xp.rank || 'Apprentice'}</span>
      </div>
      <div style="flex:1;max-width:120px;height:4px;background:rgba(99,102,241,0.12);border-radius:4px;overflow:hidden">
        <div style="height:100%;background:var(--primary);border-radius:4px;width:${Math.min(100, Math.round((xp.progress || 0) * 100))}%"></div>
      </div>
      <span style="font-size:.72rem">${fmt(xp.total || 0)} XP</span>
      ${streak.current > 0 ? `<span style="margin-left:auto;font-size:.72rem">\uD83D\uDD25 ${streak.current}d streak</span>` : ''}
      ${streak.longest > 1 ? `<span style="font-size:.72rem;opacity:.6">\uD83C\uDFC6 ${streak.longest}d best</span>` : ''}
    </div>` : ''}

    <!-- Hero stats row -->
    <div class="bento">
      <div class="bento-card accent-sessions">
        <div class="bento-icon">\uD83D\uDCAC</div>
        <div class="bento-label">Total Sessions</div>
        <div class="bento-value">${fmt(totalSessions)}</div>
        <div class="bento-sub">${activeDays} active days</div>
      </div>
      <div class="bento-card accent-turns">
        <div class="bento-icon">\uD83D\uDD04</div>
        <div class="bento-label">Total Turns</div>
        <div class="bento-value">${fmt(totalTurns)}</div>
        <div class="bento-sub">${totalSessions ? (totalTurns / totalSessions).toFixed(1) : '--'} avg/session</div>
      </div>
      <div class="bento-card accent-tokens">
        <div class="bento-icon">\uD83D\uDD24</div>
        <div class="bento-label">Total Tokens</div>
        <div class="bento-value">${fmt(totalTokens)}</div>
        <div class="bento-sub">${fmt(g.total_input || 0)} in \u00B7 ${fmt(g.total_output || 0)} out</div>
      </div>
      <div class="bento-card accent-cache">
        <div class="bento-icon">\u26A1</div>
        <div class="bento-label">Cache Hit Rate</div>
        <div class="bento-value">${avgCache != null ? avgCache.toFixed(1) + '%' : '--'}</div>
        <div class="bento-sub">prompt cache efficiency</div>
      </div>
      <div class="bento-card accent-cost">
        <div class="bento-icon">\uD83D\uDCB0</div>
        <div class="bento-label">Estimated Cost</div>
        <div class="bento-value">${fmtCost(totalCost)}</div>
        <div class="bento-sub">${totalSessions ? fmtCost(totalCost / totalSessions) + '/session' : '--'}</div>
      </div>
      <div class="bento-card accent-code">
        <div class="bento-icon">\uD83D\uDCBB</div>
        <div class="bento-label">Code Generated</div>
        <div class="bento-value">${fmt(totalCodeLines)}</div>
        <div class="bento-sub">${fmt(totalFiles)} files touched</div>
      </div>
    </div>

    <!-- Second row: deeper metrics -->
    <div class="bento" style="margin-top:12px">
      ${avgAgentic != null ? `
      <div class="bento-card accent-agentic" onclick="switchPillar('performance')">
        <div class="bento-icon">\uD83E\uDD16</div>
        <div class="bento-label">Agentic Score</div>
        <div class="bento-value">${Math.round(avgAgentic)}</div>
        <div class="bento-sub">AI autonomy (0\u2013100)</div>
      </div>` : ''}
      ${avgThinking != null ? `
      <div class="bento-card" onclick="switchPillar('performance')">
        <div class="bento-icon">\uD83E\uDDE0</div>
        <div class="bento-label">Thinking Depth</div>
        <div class="bento-value">${fmt(Math.round(avgThinking))}</div>
        <div class="bento-sub">avg thinking tokens</div>
      </div>` : ''}
      ${avgErrorRecovery != null ? `
      <div class="bento-card" onclick="switchPillar('performance')">
        <div class="bento-icon">\uD83D\uDD27</div>
        <div class="bento-label">Error Recovery</div>
        <div class="bento-value">${avgErrorRecovery.toFixed(0)}%</div>
        <div class="bento-sub">self-corrected errors</div>
      </div>` : ''}
      <div class="bento-card" onclick="switchPillar('performance')">
        <div class="bento-icon">\uD83C\uDFAF</div>
        <div class="bento-label">Models Used</div>
        <div class="bento-value">${distinctModels}</div>
        <div class="bento-sub">distinct AI models</div>
      </div>
      ${avgQuality != null ? `
      <div class="bento-card" onclick="switchPillar('performance')">
        <div class="bento-icon">\u2B50</div>
        <div class="bento-label">Avg Quality</div>
        <div class="bento-value">${avgQuality.toFixed(0)}</div>
        <div class="bento-sub">session quality score</div>
      </div>` : ''}
      ${commits.avg_ai_pct != null ? `
      <div class="bento-card accent-commits" onclick="switchPillar('performance')">
        <div class="bento-icon">\uD83D\uDCC8</div>
        <div class="bento-label">AI Authorship</div>
        <div class="bento-value">${Math.round(commits.avg_ai_pct)}%</div>
        <div class="bento-sub">${fmt(commits.total_ai_lines || 0)} AI lines</div>
      </div>` : ''}
    </div>

    <!-- Today's Activity -->
    <div style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="card" style="margin:0">
        <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Today's Activity</h2>
        ${todaySessions > 0 ? `
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">
          <div><span style="font-size:1.6rem;font-weight:800;color:var(--text-h)">${todaySessions}</span> <span style="font-size:.78rem;color:var(--text-s)">sessions</span></div>
          <div><span style="font-size:1.6rem;font-weight:800;color:var(--text-h)">${fmt(todayTurns)}</span> <span style="font-size:.78rem;color:var(--text-s)">turns</span></div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${today.map(t => `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:.74rem;font-weight:500;background:${toolColor(t.tool_id)}18;color:${toolColor(t.tool_id)};border:1px solid ${toolColor(t.tool_id)}30">
            <span style="width:6px;height:6px;border-radius:50%;background:${toolColor(t.tool_id)}"></span>
            ${t.tool_id} \u00B7 ${t.count} sessions
          </span>`).join('')}
        </div>` : '<div style="color:var(--text-s);font-size:.84rem">No sessions today yet. Start coding!</div>'}
      </div>
      <div class="card" style="margin:0">
        <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Tool Breakdown</h2>
        ${tools.length > 0 ? tools.map(t => {
          const maxS = Math.max(...tools.map(x => x.sessions));
          const pctW = maxS ? ((t.sessions / maxS) * 100).toFixed(1) : 0;
          return `<div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:.78rem;margin-bottom:3px">
              <span style="font-weight:600;color:var(--text-h)">${t.tool_id}</span>
              <span style="color:var(--text-s)">${t.sessions} sessions \u00B7 ${fmt(t.output_tokens || 0)} tokens</span>
            </div>
            <div style="height:6px;background:var(--bg-alt,#f0f0f0);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${pctW}%;background:${toolColor(t.tool_id)};border-radius:3px"></div>
            </div>
          </div>`;
        }).join('') : '<div style="color:var(--text-s);font-size:.84rem">No tool data yet.</div>'}
      </div>
    </div>

    <!-- Top Agentic Sessions + Recommendations -->
    <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      ${topAgentic.length > 0 ? `
      <div class="card" style="margin:0">
        <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Most Autonomous Sessions</h2>
        <div style="display:grid;gap:8px">
          ${topAgentic.map(s => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:var(--bg-alt,#f8f8f8)">
              <div style="min-width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#ff7e5f);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.8rem">${s.agentic_score || 0}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:.8rem;font-weight:600;color:var(--text-h);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.title || s.id?.slice(0, 12) || 'Session'}</div>
                <div style="font-size:.72rem;color:var(--text-s)">${toolChip(s.tool_id)} \u00B7 ${s.total_turns || 0} turns \u00B7 ${fmt(s.total_output_tokens || 0)} tokens</div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${recs.length > 0 ? `
      <div class="card" style="margin:0">
        <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Active Recommendations</h2>
        <div style="display:grid;gap:8px">
          ${recs.map(r => `
            <div style="padding:10px 14px;border-radius:8px;background:${r.severity === 'critical' ? 'rgba(239,68,68,0.06)' : r.severity === 'warning' ? 'rgba(245,158,11,0.06)' : 'rgba(59,130,246,0.06)'};border-left:3px solid ${r.severity === 'critical' ? '#ef4444' : r.severity === 'warning' ? '#f59e0b' : '#3b82f6'}">
              <div style="font-weight:600;font-size:.84rem;color:var(--text-h)">${r.title}</div>
              <div style="font-size:.78rem;color:var(--text-s);margin-top:2px">${r.description}</div>
            </div>`).join('')}
        </div>
      </div>` : `
      <div class="card" style="margin:0">
        <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Quick Navigation</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="bento-card" style="padding:12px;cursor:pointer" onclick="switchPillar('workspaces')">
            <div style="font-size:.82rem;font-weight:600">Sessions</div>
            <div style="font-size:.72rem;color:var(--text-s)">Browse all sessions</div>
          </div>
          <div class="bento-card" style="padding:12px;cursor:pointer" onclick="switchPillar('performance')">
            <div style="font-size:.82rem;font-weight:600">Models</div>
            <div style="font-size:.72rem;color:var(--text-s)">Compare AI models</div>
          </div>
          <div class="bento-card" style="padding:12px;cursor:pointer" onclick="switchPillar('profile')">
            <div style="font-size:.82rem;font-weight:600">Insights</div>
            <div style="font-size:.72rem;color:var(--text-s)">Your work patterns</div>
          </div>
          <div class="bento-card" style="padding:12px;cursor:pointer" onclick="switchPillar('performance')">
            <div style="font-size:.82rem;font-weight:600">Code Gen</div>
            <div style="font-size:.72rem;color:var(--text-s)">Code output stats</div>
          </div>
        </div>
      </div>`}
    </div>

    <!-- Overview charts -->
    <div style="margin-top:14px" class="g2">
      <div class="card"><h2>Daily Activity</h2><canvas id="cc-daily-chart"></canvas></div>
      <div class="card"><h2>Token Flow</h2><canvas id="cc-token-chart"></canvas></div>
    </div>

    <!-- Savings Report + Import Session -->
    <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      ${renderSavingsCard(savingsRes)}
      <div class="card" style="margin:0">
        <h2 style="font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-s);margin-bottom:12px">Import Sessions</h2>
        <p style="font-size:.82rem;color:var(--text-m);line-height:1.6;margin-bottom:14px">
          Bring in sessions from ChatGPT, Claude.ai, Gemini, or any AI tool. Paste JSON, upload a file, or use the browser bookmarklet.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="cc-import-btn" style="background:var(--primary);color:#fff;border:none;padding:8px 18px;border-radius:var(--radius-pill);cursor:pointer;font-size:.82rem;font-weight:600">Import Session</button>
          <button id="cc-bookmarklet-btn" style="background:none;border:1px solid var(--border,#e5e7eb);color:var(--text-m);padding:8px 18px;border-radius:var(--radius-pill);cursor:pointer;font-size:.82rem">Get Bookmarklet</button>
        </div>
      </div>
    </div>`;

  // Render charts with all-time data
  const daily = ov.daily || [];
  if (daily.length > 0) {
    const dates = [...new Set(daily.map(d => d.date))].sort();
    const toolIds = [...new Set(daily.map(d => d.tool_id))];

    // Downsample if too many dates for readability
    const step = dates.length > 90 ? Math.ceil(dates.length / 90) : 1;
    const sampledDates = dates.filter((_, i) => i % step === 0);

    mc('cc-daily-chart', {
      type: 'bar',
      data: {
        labels: sampledDates.map(d => d.slice(5)),
        datasets: toolIds.map(tid => ({
          label: tid,
          data: sampledDates.map(date => {
            const row = daily.find(d => d.date === date && d.tool_id === tid);
            return row?.total_turns || 0;
          }),
          backgroundColor: toolColor(tid),
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { stacked: true, ticks: { maxRotation: 45, maxTicksLimit: 20 } },
          y: { stacked: true, beginAtZero: true },
        },
      },
    });

    mc('cc-token-chart', {
      type: 'line',
      data: {
        labels: sampledDates.map(d => d.slice(5)),
        datasets: toolIds.map(tid => ({
          label: tid,
          data: sampledDates.map(date => {
            const row = daily.find(d => d.date === date && d.tool_id === tid);
            return row?.total_output_tokens || 0;
          }),
          borderColor: toolColor(tid),
          backgroundColor: toolColor(tid) + '18',
          fill: true,
          tension: 0.3,
          pointRadius: 1,
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { ticks: { maxRotation: 45, maxTicksLimit: 20 } },
          y: { beginAtZero: true, ticks: { callback: v => fmt(v) } },
        },
      },
    });
  }

  // Wire up savings toggle
  const savingsToggle = document.getElementById('savings-dollar-toggle');
  if (savingsToggle) {
    savingsToggle.onchange = () => {
      const rel = document.getElementById('savings-relative');
      const dol = document.getElementById('savings-dollars');
      if (rel && dol) {
        rel.style.display = savingsToggle.checked ? 'none' : '';
        dol.style.display = savingsToggle.checked ? '' : 'none';
      }
    };
  }

  // Wire up import + bookmarklet buttons
  const importBtn = document.getElementById('cc-import-btn');
  if (importBtn) importBtn.onclick = showImportModal;
  const bmBtn = document.getElementById('cc-bookmarklet-btn');
  if (bmBtn) bmBtn.onclick = showBookmarkletModal;
}

// ---- Combined Insights & Optimization ----
async function renderCombinedInsights() {
  const panel = document.getElementById('prof-insights');
  if (!panel) return;

  // Mount insights section first
  _mountV2Tab('t-insights', 'prof-insights');
  rIns();

  // Then append optimization recommendations below
  let optContainer = document.getElementById('combined-opt-section');
  if (!optContainer) {
    optContainer = document.createElement('div');
    optContainer.id = 'combined-opt-section';
    optContainer.style.cssText = 'padding:16px 24px 40px';
    panel.appendChild(optContainer);
  }

  // Fetch recommendations
  if (!S.recs) S.recs = await fJ('/api/recommendations?all=true');
  const recs = S.recs || [];
  const active = recs.filter(r => !r.dismissed);

  if (active.length === 0) {
    optContainer.innerHTML = `<div class="card" style="margin-top:20px"><h2>Optimization Recommendations</h2><p style="color:var(--text-s);padding:12px 0">All clear — no recommendations right now.</p></div>`;
    return;
  }

  // Group and sort
  const grouped = new Map();
  for (const r of active) {
    if (!grouped.has(r.title)) grouped.set(r.title, { ...r, count: 1 });
    else grouped.get(r.title).count++;
  }
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  const sorted = [...grouped.values()].sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3) || b.count - a.count);

  optContainer.innerHTML = `
    <div class="card" style="margin-top:20px">
      <h2>Optimization Recommendations (${sorted.length})</h2>
      <div class="rg" style="margin-top:12px">
        ${sorted.map(r => `
          <div class="rc ${r.severity}">
            <div class="rc-cat">${r.category}${r.tool_id ? ' — ' + r.tool_id : ''}</div>
            <div class="rc-t">${r.title}${r.count > 1 ? ` <span style="background:rgba(0,0,0,.08);border-radius:20px;padding:1px 7px;font-size:.68rem">${r.count}x</span>` : ''}</div>
            <div class="rc-d">${r.description}</div>
            ${r.action ? `<div class="rc-a">${r.action}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

// ---- Cursor Deep Dive ----
async function renderCursorDeepDive() {
  const panel = document.getElementById('perf-cursor');
  if (!panel) return;

  const data = await fJ('/api/cursor/deep');
  if (!data || !data.overview) {
    panel.innerHTML = '<div style="padding:24px;color:var(--text-s)">No Cursor data available. Make sure Cursor state DB is detected.</div>';
    return;
  }

  const ov = data.overview;
  const models = data.modelBreakdown || [];
  const topSessions = data.topSessions || [];

  panel.innerHTML = `
    <div style="padding:16px 24px 40px">
      <!-- Cursor Overview KPIs -->
      <div class="kpi" id="cursor-kpis"></div>

      <!-- Model Breakdown -->
      <div class="g2" style="margin-top:16px">
        <div class="card">
          <h2>Model Usage Distribution</h2>
          <canvas id="c-cursor-model-dist" style="max-height:280px"></canvas>
        </div>
        <div class="card">
          <h2>Model Performance Radar</h2>
          <canvas id="c-cursor-model-radar" style="max-height:280px"></canvas>
        </div>
      </div>

      <!-- Model Comparison Table -->
      <div class="card" style="margin-top:14px">
        <h2>Model-by-Model Comparison</h2>
        <div style="overflow-x:auto">
          <table><thead><tr>
            <th>Model</th><th class="num">Sessions</th><th class="num">Turns</th>
            <th class="num">Output Tokens</th><th class="num">Cache Hit</th>
            <th class="num">Suggestions Accepted</th><th class="num">Lint Improvement</th>
            <th class="num">Thinking Depth</th><th class="num">Agentic Score</th>
          </tr></thead><tbody id="cursor-model-body"></tbody></table>
        </div>
      </div>

      <!-- Top Sessions -->
      <div class="card" style="margin-top:14px">
        <h2>Top Cursor Sessions by Output</h2>
        <div style="overflow-x:auto">
          <table><thead><tr>
            <th>Date</th><th>Model</th><th class="num">Turns</th>
            <th class="num">Output</th><th class="num">Cache</th>
            <th class="num">Suggestions</th><th class="num">Lint</th>
            <th class="num">Lines</th><th class="num">Agentic</th>
          </tr></thead><tbody id="cursor-sessions-body"></tbody></table>
        </div>
      </div>

      <!-- Daily Activity Chart -->
      <div class="card" style="margin-top:14px">
        <h2>Cursor Daily Activity</h2>
        <canvas id="c-cursor-daily-deep"></canvas>
      </div>
    </div>`;

  // KPIs
  $('cursor-kpis').innerHTML = [
    kpi(fmt(ov.total_sessions), 'Cursor Sessions', '--primary'),
    kpi(fmt(ov.total_turns), 'Total Turns', '--c-input'),
    kpi(fmt(ov.total_output), 'Output Tokens', '--c-output'),
    kpi(ov.avg_cache_pct != null ? Math.round(ov.avg_cache_pct) + '%' : '--', 'Cache Hit', '--c-cache-read'),
    kpi(ov.avg_suggestion_acceptance != null ? Math.round(ov.avg_suggestion_acceptance) + '%' : '--', 'Suggestion Accept', '--c-cache-create'),
    kpi(ov.avg_lint_improvement != null ? Math.round(ov.avg_lint_improvement) + '%' : '--', 'Lint Improvement', '--lv-good'),
    kpi(fmt(ov.total_code_lines || 0), 'Code Lines', '--accent-performance'),
    kpi(ov.avg_agentic_score != null ? Math.round(ov.avg_agentic_score) : '--', 'Agentic Score', '--lv-tip'),
  ].join('');

  // Model distribution doughnut
  if (models.length > 0) {
    mc('c-cursor-model-dist', {
      type: 'doughnut',
      data: {
        labels: models.map(m => (m.model || 'unknown').replace('claude-', '').replace(/-\d{8}$/, '')),
        datasets: [{
          data: models.map(m => m.sessions),
          backgroundColor: models.map((_, i) => MODEL_COLORS[i % MODEL_COLORS.length]),
          borderWidth: 2, borderColor: 'var(--bg-card)',
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 10, color: 'var(--text-m)' } } },
      },
    });

    // Radar chart for top 5 models
    const top5 = models.slice(0, 5);
    mc('c-cursor-model-radar', {
      type: 'radar',
      data: {
        labels: ['Cache %', 'Suggestion Accept %', 'Lint Fix %', 'Thinking Depth', 'Agentic Score'],
        datasets: top5.map((m, i) => ({
          label: (m.model || '').replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 18),
          data: [
            m.avg_cache_pct || 0,
            m.avg_suggestion_acceptance || 0,
            m.avg_lint_improvement || 0,
            Math.min(100, (m.avg_thinking_depth || 0) / 10), // normalize to ~100 scale
            m.avg_agentic_score || 0,
          ],
          borderColor: MODEL_COLORS[i],
          backgroundColor: MODEL_COLORS[i] + '20',
          pointBackgroundColor: MODEL_COLORS[i],
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 9 }, boxWidth: 8 } } },
        scales: { r: { beginAtZero: true, max: 100, ticks: { stepSize: 20, font: { size: 8 } } } },
      },
    });
  }

  // Model comparison table
  $('cursor-model-body').innerHTML = models.map(m => `<tr>
    <td style="font-weight:600;font-size:.78rem">${(m.model || 'unknown').replace('claude-', '').replace(/-\d{8}$/, '')}</td>
    <td class="num">${m.sessions}</td>
    <td class="num">${fmt(m.total_turns)}</td>
    <td class="num">${fmt(m.total_output)}</td>
    <td class="num">${m.avg_cache_pct != null ? Math.round(m.avg_cache_pct) + '%' : '--'}</td>
    <td class="num">${m.avg_suggestion_acceptance != null ? Math.round(m.avg_suggestion_acceptance) + '%' : '--'}</td>
    <td class="num">${m.avg_lint_improvement != null ? Math.round(m.avg_lint_improvement) + '%' : '--'}</td>
    <td class="num">${m.avg_thinking_depth != null ? fmt(Math.round(m.avg_thinking_depth)) : '--'}</td>
    <td class="num">${m.avg_agentic_score != null ? Math.round(m.avg_agentic_score) : '--'}</td>
  </tr>`).join('');

  // Top sessions table
  $('cursor-sessions-body').innerHTML = topSessions.map(s => `<tr>
    <td style="white-space:nowrap;font-size:.76rem">${fD(s.started_at)}</td>
    <td style="font-size:.76rem">${(s.primary_model || '').replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 16)}</td>
    <td class="num">${s.total_turns || 0}</td>
    <td class="num">${fmt(s.total_output_tokens)}</td>
    <td class="num">${s.cache_hit_pct != null ? Math.round(s.cache_hit_pct) + '%' : '--'}</td>
    <td class="num">${s.suggestion_acceptance_pct != null ? Math.round(s.suggestion_acceptance_pct) + '%' : '--'}</td>
    <td class="num">${s.lint_improvement != null ? Math.round(s.lint_improvement) + '%' : '--'}</td>
    <td class="num">${fmt(s.code_lines_added)}</td>
    <td class="num">${s.agentic_score != null ? s.agentic_score : '--'}</td>
  </tr>`).join('');

  // Daily activity line chart
  const daily = data.dailyActivity || [];
  if (daily.length > 0) {
    const step = daily.length > 90 ? Math.ceil(daily.length / 90) : 1;
    const sampled = daily.filter((_, i) => i % step === 0);
    mc('c-cursor-daily-deep', {
      type: 'line',
      data: {
        labels: sampled.map(d => d.date?.slice(5)),
        datasets: [
          {
            label: 'Turns',
            data: sampled.map(d => d.turns || 0),
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139,92,246,0.08)',
            fill: true, tension: 0.3, pointRadius: 1, yAxisID: 'y',
          },
          {
            label: 'Output Tokens',
            data: sampled.map(d => d.output_tokens || 0),
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245,158,11,0.08)',
            fill: true, tension: 0.3, pointRadius: 1, yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { ticks: { maxRotation: 45, maxTicksLimit: 20 } },
          y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Turns', font: { size: 9 } } },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Output Tokens', font: { size: 9 } }, ticks: { callback: v => fmt(v) } },
        },
      },
    });
  }
}

// ---- Workspaces (Projects sub-tab) ----
async function renderWorkspaces() {
  const el = document.getElementById('p-workspaces-inner');
  if (!el) return;

  if (!S.projects) S.projects = await fJ('/api/projects');

  const projects = (S.projects?.projects || []).slice(0, 40);

  el.innerHTML = `
    <h3 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-s);margin-bottom:12px">Projects (${projects.length})</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">
      ${projects.map(p => `
        <div class="bento-card" style="padding:16px" onclick="openProjectDrawer('${encodeURIComponent(p.project_name || '')}','${encodeURIComponent(p.project_name || 'Unnamed')}')">
          <div style="font-weight:600;font-size:.9rem;color:var(--text-h);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.project_name || 'Unnamed'}</div>
          <div style="font-size:.76rem;color:var(--text-s)">${p.session_count || 0} sessions \u00B7 ${fmt(p.total_tokens || 0)} tokens</div>
          <div style="font-size:.72rem;color:var(--text-s);margin-top:4px">${p.dominant_tool || '--'}</div>
        </div>`).join('') || '<p style="color:var(--text-s)">No projects yet.</p>'}
    </div>`;
}

function _renderSessionRows(sessions, noQuality) {
  if (!sessions || !sessions.length) return '<p style="color:var(--text-s)">No sessions yet.</p>';
  return sessions.map(s => `
    <div style="background:var(--bg-card);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
      <div style="width:8px;height:8px;border-radius:50%;background:${toolColor(s.tool_id)};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:.84rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.label || 'Session ' + (s.id || '').slice(0, 8)}</div>
        <div style="font-size:.74rem;color:var(--text-s)">${s.tool_id} \u00B7 ${fD(s.started_at)} \u00B7 ${s.total_turns} turns</div>
      </div>
      ${!noQuality && s.quality_score != null ? `<div style="font-size:.78rem;font-weight:600;color:${s.quality_score > 70 ? '#10b981' : s.quality_score > 40 ? '#f59e0b' : '#ef4444'}">${s.quality_score.toFixed(0)}</div>` : ''}
    </div>`).join('');
}

async function openProjectDrawer(encodedName, encodedDisplay) {
  const name = decodeURIComponent(encodedName);
  const display = decodeURIComponent(encodedDisplay);
  openDrawer(display, '<div style="text-align:center;padding:20px;color:var(--text-s)">Loading\u2026</div>');
  const data = await fJ('/api/projects/' + encodeURIComponent(name) + '/insights');
  const sessions = (S.sessions || []).filter(s => s.project_name === name).slice(0, 5);
  const contentEl = document.getElementById('drawer-content');
  if (!contentEl) return;
  contentEl.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      <div style="background:var(--bg-body,#f4f6f8);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:700">${data?.sessionCount || '--'}</div>
        <div style="font-size:.74rem;color:var(--text-s)">Sessions</div>
      </div>
      <div style="background:var(--bg-body,#f4f6f8);border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:700">${fmt(data?.totalTokens || 0)}</div>
        <div style="font-size:.74rem;color:var(--text-s)">Tokens</div>
      </div>
    </div>
    <h4 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-s);margin-bottom:10px">Recent Sessions</h4>
    ${sessions.map(s => `
      <div style="padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:.84rem;font-weight:500">${s.label || 'Session ' + (s.id || '').slice(0, 8)}</div>
        <div style="font-size:.74rem;color:var(--text-s)">${s.tool_id} \u00B7 ${fD(s.started_at)} \u00B7 ${s.total_turns} turns</div>
      </div>`).join('') || '<p style="color:var(--text-s);font-size:.84rem">No sessions yet.</p>'}`;
}

// ---- Performance ----
let _perfView = 'tools';

async function renderPerformance() {
  const el = document.getElementById('p-performance-inner');
  if (!el) return;

  // Wire up filter pills
  document.querySelectorAll('#perf-pills .filter-pill').forEach(btn => {
    btn.onclick = () => {
      _perfView = btn.dataset.perf;
      document.querySelectorAll('#perf-pills .filter-pill').forEach(b => b.classList.toggle('active', b.dataset.perf === _perfView));
      renderPerfContent(el);
    };
  });
  await renderPerfContent(el);
}

async function renderPerfContent(el) {
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-s)">Loading\u2026</div>';

  if (_perfView === 'tools') {
    // API returns array directly (not wrapped in {tools:[]})
    if (!S.compare) S.compare = await fJ('/api/compare');
    const tools = Array.isArray(S.compare) ? S.compare : (S.compare?.tools || []);
    el.innerHTML = `
      <div style="display:grid;gap:10px">
        ${tools.map(t => `
          <div style="background:var(--bg-card);border-radius:12px;padding:16px 20px;display:grid;grid-template-columns:1fr repeat(4,auto);gap:16px;align-items:center">
            <div>
              <div style="font-weight:600;font-size:.9rem">${toolChip(t.tool_id)} ${t.tool_id}</div>
              <div style="font-size:.74rem;color:var(--text-s)">${t.sessions || t.sessionCount || 0} sessions</div>
            </div>
            <div style="text-align:center"><div style="font-weight:700">${fmt((t.output_tokens || t.totalTokens || 0))}</div><div style="font-size:.7rem;color:var(--text-s)">tokens</div></div>
            <div style="text-align:center"><div style="font-weight:700">${t.avg_quality != null ? t.avg_quality.toFixed(0) : (t.avgQuality != null ? t.avgQuality.toFixed(0) : '--')}</div><div style="font-size:.7rem;color:var(--text-s)">quality</div></div>
            <div style="text-align:center"><div style="font-weight:700">${t.avg_cache_pct != null ? t.avg_cache_pct.toFixed(0) : (t.avgCacheHit != null ? t.avgCacheHit.toFixed(0) : '--')}%</div><div style="font-size:.7rem;color:var(--text-s)">cache</div></div>
            <div style="text-align:center"><div style="font-weight:700">${t.avg_turns_per_session != null ? t.avg_turns_per_session.toFixed(0) : (t.avgTurns != null ? t.avgTurns.toFixed(0) : '--')}</div><div style="font-size:.7rem;color:var(--text-s)">avg turns</div></div>
          </div>`).join('') || '<p style="color:var(--text-s)">No tool comparison data yet.</p>'}
      </div>`;
  } else if (_perfView === 'models') {
    // API returns array directly (not wrapped in {byModel:[]})
    if (!S.models) S.models = await fJ('/api/models');
    const rows = Array.isArray(S.models) ? S.models : (S.models?.byModel || []);
    el.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.84rem">
          <thead><tr style="border-bottom:2px solid rgba(0,0,0,0.06)">${['Model', 'Sessions', 'Output Tokens', 'Avg Cache', 'Avg Latency'].map(h => `<th style="text-align:left;padding:8px 12px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-s)">${h}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, 15).map((r, i) => `<tr style="border-bottom:1px solid rgba(0,0,0,0.04);${i % 2 ? 'background:rgba(0,0,0,0.015)' : ''}"><td style="padding:10px 12px">${r.model}</td><td style="padding:10px 12px">${r.sessions || r.sessionCount || 0}</td><td style="padding:10px 12px">${fmt(r.output_tokens || r.totalTokens || 0)}</td><td style="padding:10px 12px">${r.avg_cache_pct != null ? r.avg_cache_pct.toFixed(0) + '%' : '--'}</td><td style="padding:10px 12px">${r.avg_latency != null ? (r.avg_latency / 1000).toFixed(1) + 's' : '--'}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  } else if (_perfView === 'codegen') {
    // API returns {byTool:[], topSessions:[], byModel:[]} — aggregate from byTool
    if (!S.codeGen) S.codeGen = await fJ('/api/code-generation');
    const byTool = (S.codeGen?.byTool || []);
    const totalAdded = byTool.reduce((s, t) => s + (t.total_lines_added || 0), 0);
    const totalRemoved = byTool.reduce((s, t) => s + (t.total_lines_removed || 0), 0);
    const totalFiles = byTool.reduce((s, t) => s + (t.total_files_touched || 0), 0);
    el.innerHTML = `
      <div class="bento" style="padding:0;margin:0">
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">Lines Added</div>
          <div class="bento-value">${fmt(totalAdded)}</div>
        </div>
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">Lines Deleted</div>
          <div class="bento-value">${fmt(totalRemoved)}</div>
        </div>
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">Files Touched</div>
          <div class="bento-value">${fmt(totalFiles)}</div>
        </div>
      </div>
      ${byTool.length ? `<div style="margin-top:20px;display:grid;gap:8px">
        ${byTool.map(t => `<div style="background:var(--bg-card);border-radius:10px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">${toolChip(t.tool_id)} ${t.tool_id}</span>
          <span style="font-size:.8rem;color:var(--text-s)">+${fmt(t.total_lines_added||0)} / -${fmt(t.total_lines_removed||0)} lines</span>
        </div>`).join('')}
      </div>` : ''}`;
  } else {
    el.innerHTML = '<p style="color:var(--text-s);padding:20px">Task type routing coming soon.</p>';
  }
}

// ---- Profile Pillar ----
async function renderProfilePillar() {
  const el = document.getElementById('p-profile-inner');
  if (!el) return;

  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-s)">Loading\u2026</div>';

  if (!S.personal) S.personal = await fJ('/api/personal-insights');
  if (!S.costs) S.costs = await fJ('/api/costs');

  const pi = S.personal || {};
  const costs = S.costs || {};

  // API shape: pi.xp = {total, level, rank, currentLevelXP, nextLevelXP, progress}
  // pi.streak = {current, longest}
  // pi.lifetime = {sessions, outputTokens, aiLines, codeLines, daysActive, totalTurns}
  // pi.achievements = [{id, cat, icon, title, desc, earned, threshold}]
  // pi.goldenHours = [{hour, avgQuality, sessionCount}]
  // pi.heatmap = [{date, count}]
  // pi.records = [{label, value, date}]

  const xp = pi.xp || {};
  const streak = pi.streak || {};
  const lifetime = pi.lifetime || {};
  const achievements = (pi.achievements || []).filter(a => a.earned);
  const records = pi.records || [];
  const goldenHours = (pi.goldenHours || []).slice(0, 3);

  el.innerHTML = `
    <div style="padding:20px;max-width:1200px;margin:0 auto">

      ${xp.level != null ? `
      <!-- Level / XP Hero -->
      <div style="background:linear-gradient(135deg,var(--bg-card) 0%,rgba(241,90,43,0.06) 100%);border:1px solid rgba(241,90,43,0.15);border-radius:16px;padding:28px;margin-bottom:20px;display:flex;align-items:center;gap:24px;flex-wrap:wrap">
        <div style="text-align:center;min-width:80px">
          <div style="font-size:2.8rem;font-weight:900;color:var(--primary);font-family:var(--font-mono)">Lv.${xp.level}</div>
          <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-s);font-weight:700">${xp.rank || 'Apprentice'}</div>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--text-s);margin-bottom:6px">
            <span>${fmt(xp.currentLevelXP || 0)} XP</span>
            <span>${fmt(xp.nextLevelXP || 0)} XP to next level</span>
          </div>
          <div style="height:10px;background:rgba(255,255,255,0.08);border-radius:50px;overflow:hidden">
            <div style="height:100%;background:var(--primary);border-radius:50px;width:${Math.min(100, Math.round((xp.progress || 0) * 100))}%;transition:width .6s ease"></div>
          </div>
          <div style="display:flex;gap:20px;margin-top:12px;flex-wrap:wrap">
            <span style="font-size:.8rem;color:var(--text-s)">\uD83D\uDD25 <strong style="color:var(--text-h)">${streak.current || 0}</strong>-day streak</span>
            <span style="font-size:.8rem;color:var(--text-s)">\uD83C\uDFC6 Best: <strong style="color:var(--text-h)">${streak.longest || 0}</strong> days</span>
            <span style="font-size:.8rem;color:var(--text-s)">\uD83D\uDCC5 <strong style="color:var(--text-h)">${lifetime.daysActive || 0}</strong> days active</span>
          </div>
        </div>
      </div>` : ''}

      <!-- Lifetime Stats -->
      <div class="bento" style="padding:0;margin-bottom:20px">
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">Sessions</div>
          <div class="bento-value">${fmt(lifetime.sessions || 0)}</div>
          <div class="bento-sub">lifetime total</div>
        </div>
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">Total Turns</div>
          <div class="bento-value">${fmt(lifetime.totalTurns || 0)}</div>
          <div class="bento-sub">messages sent</div>
        </div>
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">AI Lines</div>
          <div class="bento-value">${fmt(lifetime.aiLines || 0)}</div>
          <div class="bento-sub">AI-assisted code</div>
        </div>
        <div class="bento-card" style="cursor:default">
          <div class="bento-label">Est. Cost</div>
          <div class="bento-value">$${(costs.totalCost || 0).toFixed(2)}</div>
          <div class="bento-sub">all sessions</div>
        </div>
      </div>

      ${achievements.length > 0 ? `
      <!-- Achievements -->
      <h3 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-s);margin-bottom:12px">Achievements (${achievements.length} unlocked)</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px">
        ${achievements.slice(0, 12).map(a => `
          <div title="${a.desc}" style="background:var(--bg-card);border:1px solid rgba(241,90,43,0.2);border-radius:10px;padding:10px 14px;text-align:center;min-width:80px;cursor:default">
            <div style="font-size:1.4rem">${a.icon || '\uD83C\uDFC6'}</div>
            <div style="font-size:.68rem;font-weight:600;margin-top:4px;color:var(--text-h)">${a.title}</div>
            <div style="font-size:.62rem;color:var(--text-s)">${a.cat}</div>
          </div>`).join('')}
      </div>` : ''}

      ${goldenHours.length > 0 ? `
      <!-- Golden Hours -->
      <h3 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-s);margin-bottom:12px">Golden Hours</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px">
        ${goldenHours.map((h) => {
          const hr = h.hour != null ? (h.hour % 12 || 12) + (h.hour < 12 ? 'am' : 'pm') : '--';
          return `<div style="background:var(--bg-card);border-radius:10px;padding:14px;border-left:3px solid var(--primary)">
            <div style="font-size:1.2rem;font-weight:700;font-family:var(--font-mono)">${hr}</div>
            <div style="font-size:.74rem;color:var(--text-s)">${h.sessionCount || 0} sessions \u00B7 ${h.avgQuality != null ? h.avgQuality.toFixed(0) : '--'} quality</div>
          </div>`;
        }).join('')}
      </div>` : ''}

      ${records.length > 0 ? `
      <!-- Personal Records -->
      <h3 style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-s);margin-bottom:12px">Personal Records</h3>
      <div style="display:grid;gap:6px;margin-bottom:24px">
        ${records.slice(0, 8).map(r => `
          <div style="background:var(--bg-card);border-radius:8px;padding:10px 16px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:.82rem;color:var(--text-s)">${r.label}</span>
            <span style="font-weight:700;font-family:var(--font-mono);color:var(--text-h)">${typeof r.value === 'number' ? fmt(r.value) : r.value}</span>
          </div>`).join('')}
      </div>` : ''}

    </div>`;
}

// ---- Init Pillar System ----
function initPillarNav() {
  // Desktop nav
  document.querySelectorAll('.pillar-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPillar(btn.dataset.pillar));
  });
  // Mobile nav
  document.querySelectorAll('.pillar-bottom-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPillar(btn.dataset.pillar));
  });
  // Command palette triggers
  const trigger = document.getElementById('cmdk-trigger');
  if (trigger) trigger.addEventListener('click', openCmdK);
  const fab = document.getElementById('fab-cmdk');
  if (fab) fab.addEventListener('click', openCmdK);
  // Keyboard shortcut
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      _cmdkOpen ? closeCmdK() : openCmdK();
    }
  });
  // Render initial pillar
  switchPillar('command');
}

// Start the pillar system after DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPillarNav);
} else {
  initPillarNav();
}

// ── Theme Toggle ──────────────────────────────────────────────────────────────
(function() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const update = () => {
      const t = document.documentElement.getAttribute('data-theme');
      btn.textContent = t === 'light' ? '☽' : '◐';
      btn.title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    };
    update();
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      update();
    });
  });
})();
