// ---------- lively background: drifting aurora blobs + rising gold embers ----------
const canvas = document.getElementById('bg');
const ctx = canvas.getContext('2d');
let W, H;
function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
addEventListener('resize', resize); resize();

const blobs = Array.from({ length: 4 }, (_, i) => ({
  x: Math.random() * W, y: Math.random() * H,
  r: 260 + Math.random() * 220,
  dx: (Math.random() - 0.5) * 0.18, dy: (Math.random() - 0.5) * 0.14,
  hue: i % 2 ? 'rgba(51,149,255,' : 'rgba(24,72,180,',
  a: 0.06 + Math.random() * 0.05,
}));
const embers = Array.from({ length: 70 }, () => ({
  x: Math.random() * W, y: Math.random() * H,
  r: 0.6 + Math.random() * 1.8,
  vy: 0.12 + Math.random() * 0.45,
  vx: (Math.random() - 0.5) * 0.12,
  tw: Math.random() * Math.PI * 2,
}));

function draw(t) {
  ctx.clearRect(0, 0, W, H);
  for (const b of blobs) {
    b.x += b.dx; b.y += b.dy;
    if (b.x < -b.r) b.x = W + b.r; if (b.x > W + b.r) b.x = -b.r;
    if (b.y < -b.r) b.y = H + b.r; if (b.y > H + b.r) b.y = -b.r;
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, b.hue + b.a + ')');
    g.addColorStop(1, b.hue + '0)');
    ctx.fillStyle = g;
    ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
  for (const e of embers) {
    e.y -= e.vy; e.x += e.vx + Math.sin(t / 1400 + e.tw) * 0.08;
    if (e.y < -4) { e.y = H + 4; e.x = Math.random() * W; }
    const glow = 0.35 + 0.3 * Math.sin(t / 600 + e.tw);
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(122,181,255,${glow})`;
    ctx.fill();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---------- data layer ----------
const $ = (s) => document.querySelector(s);
const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  post: (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()),
};
let merchant = null;
const inr = (paise) => '₹' + (paise / 100).toLocaleString('en-IN');

async function init() {
  try {
    const man = await api.get('/api/s/manifest');
    merchant = man.merchant;
    $('#merchant-badge').textContent = `merchant: ${man.merchant} · ${man.payment_mode}`;
  } catch { $('#merchant-badge').textContent = 'merchant: storefront offline'; }
}

$('#mandate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!merchant) return alert('storefront offline');
  await api.post('/api/m/mandates', {
    merchant,
    cap_inr: Number($('#f-cap').value),
    max_uses: Number($('#f-uses').value),
    expiry_minutes: Number($('#f-exp').value),
  });
  refresh();
});

function mandateCard(m) {
  const spentPct = Math.min(100, (m.spent_paise / m.cap_paise) * 100);
  const heldPct = Math.min(100 - spentPct, ((m.held_paise || 0) / m.cap_paise) * 100);
  const mins = Math.max(0, Math.round((new Date(m.expires_at) - Date.now()) / 60000));
  const attemptsLeft = (m.max_attempts ?? 0) - (m.attempts_used ?? 0);
  return `<div class="card">
    <div class="mandate-head">
      <b>${m.merchant}${m.category && m.category !== 'any' ? ` · ${m.category}` : ''}</b>
      <span class="chip ${m.state}">${m.state}</span>
    </div>
    <div class="meter"><i style="width:${spentPct}%"></i><u style="width:${heldPct}%"></u></div>
    <div class="mandate-meta">
      <span>${inr(m.spent_paise)} / ${inr(m.cap_paise)}${m.held_paise ? ` · ${inr(m.held_paise)} held` : ''}</span>
      <span>${m.uses_left}/${m.max_uses} uses · ${attemptsLeft} attempts · ${mins}m left</span>
    </div>
    <div class="mandate-meta" style="margin-top:8px">
      <span class="mono">${m.id}</span>
      ${m.state === 'ACTIVE' ? `<button class="btn ghost" onclick="revoke('${m.id}')">revoke ✕</button>` : ''}
    </div>
  </div>`;
}

window.revoke = async (id) => { await api.post(`/api/m/mandates/${id}/revoke`); refresh(); };
window.decide = async (id, approve) => { await api.post(`/api/m/escalations/${id}/decide`, { approve }); refresh(); };

function escCard(e) {
  return `<div class="card esc">
    <div class="mandate-head"><b>${inr(e.amount_paise)} — ${e.merchant}</b><span class="chip ACTIVE">PENDING</span></div>
    <div class="why"><svg style="width:13px;height:13px;vertical-align:-2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 L22 20 H2 Z M12 9.5 v4.5 M12 17 v.01"/></svg> ${e.reason}</div>
    ${e.intent ? `<div class="intent">agent: “${e.intent}”</div>` : ''}
    <div class="actions">
      <button class="btn approve" onclick="decide('${e.id}', true)">✓ Approve</button>
      <button class="btn deny" onclick="decide('${e.id}', false)">✕ Deny</button>
    </div>
  </div>`;
}

function summarize(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'MANDATE_CREATED': return `${d.merchant} · cap ₹${d.cap_inr} · ${d.max_uses} uses · ${d.expiry_minutes}m`;
    case 'MANDATE_CHECK': return `${d.decision} — ${d.reason}${d.attempts_left !== undefined ? ` · ${d.attempts_left} attempts left` : ''}`;
    case 'INTENT_DECLARED': return `${d.product} · ₹${d.amount_inr} — “${d.reasoning}”`;
    case 'ESCALATION_RAISED': return d.reason;
    case 'ESCALATION_DECIDED': return `${d.decision} · ${inr(d.amount_paise)}`;
    case 'ORDER_CREATED': return `${d.order_id} · ₹${d.total_inr} · ${(d.lines || []).map((l) => l.name).join(', ')}`;
    case 'PAYMENT_ATTEMPT': return `attempt ${d.attempt} · ${d.method} · ₹${d.amount_inr}`;
    case 'PAYMENT_FAILED': return `${d.error} — ${d.description || ''}`;
    case 'PAYMENT_SUCCEEDED': return `${d.payment_id} · ₹${d.amount_inr} via ${d.method}`;
    case 'PAYMENT_BLOCKED': return d.reason;
    case 'PAYMENT_CHALLENGED': return `402 mandate required — ${d.reason}`;
    case 'RETRY_POLICY': return d.decision;
    case 'HOLD_RELEASED': return `${inr(d.amount_paise)} back on the mandate — ${d.reason}`;
    case 'MANDATE_CONSUMED': return `${inr(d.amount_paise)} · ${d.uses_left} uses left`;
    case 'MANDATE_REVOKED': return `${d.mandate_id} (${d.merchant})`;
    case 'AGENT_NOTE': return d.final_summary ? d.final_summary.slice(0, 220) : JSON.stringify(d).slice(0, 220);
    default: return JSON.stringify(d).slice(0, 200);
  }
}

// ---------- run agent from the browser ----------
let agentBusy = false;

// small stroke icons for the step timeline
const STEP_ICON = {
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15 L20.5 20.5"/>',
  product: '<path d="M3.5 8.5 L12 3.5 L20.5 8.5 V15.5 L12 20.5 L3.5 15.5 Z"/><path d="M12 12 V20.5 M3.5 8.5 L12 12 L20.5 8.5"/>',
  intent: '<path d="M4 5 h16 v11 h-9 l-4.5 3.5 V16 H4 Z"/><path d="M8 9 h8 M8 12 h5"/>',
  order: '<path d="M4.5 7 h15 l-1.5 12 h-12 Z"/><path d="M9 7 a3 3 0 0 1 6 0"/>',
  pay: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5 h18"/>',
  wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5 V12 l3 2.5"/>',
  shield: '<path d="M12 2.5 L20 5.5 V11.5 C20 16.5 16.7 20.2 12 21.5 C7.3 20.2 4 16.5 4 11.5 V5.5 Z"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 8 V4.5 M9.5 13 v.01 M14.5 13 v.01"/>',
};
const ico = (k, cls) => `<svg class="si ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${STEP_ICON[k]}</svg>`;
const esc_ = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

// turn agent NDJSON events into friendly timeline cards
function renderSteps(events, status) {
  const html = [];
  const steps = [];
  for (const ev of events) {
    if (ev.e === 'tool') steps.push({ kind: 'tool', name: ev.name, args: ev.args, result: null });
    else if (ev.e === 'result') { const s = [...steps].reverse().find((x) => x.kind === 'tool' && x.name === ev.name && !x.result); if (s) s.result = ev.data; }
    else steps.push({ kind: ev.e, ev });
  }

  for (const s of steps) {
    if (s.kind === 'start') {
      html.push(`<div class="step">${ico('shield')}<div><div class="t">Connected to ${esc_(s.ev.merchant)}</div><div class="d">payments: ${esc_(s.ev.payment_mode)}</div></div></div>`);
    } else if (s.kind === 'mandate') {
      html.push(`<div class="step">${ico('shield')}<div><div class="t">Mandate granted — cap ₹${s.ev.cap_inr}</div><div class="d mono-sm">${esc_(s.ev.id)}</div></div></div>`);
    } else if (s.kind === 'waiting') {
      html.push(`<div class="step warn">${ico('wait')}<div><div class="t">Waiting for your approval</div><div class="d">check the Escalations column and click Approve or Deny</div></div></div>`);
    } else if (s.kind === 'decision') {
      const ok = s.ev.decision === 'APPROVED';
      html.push(`<div class="step ${ok ? 'good' : 'bad'}">${ico('wait')}<div><div class="t">You ${ok ? 'approved' : s.ev.decision === 'DENIED' ? 'denied' : 'did not decide in time'}</div></div></div>`);
    } else if (s.kind === 'final') {
      const pretty = esc_(s.ev.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      html.push(`<div class="final-bubble">${ico('bot')}<div>${pretty}</div></div>`);
    } else if (s.kind === 'error') {
      html.push(`<div class="step bad">${ico('bot')}<div><div class="t">Something went wrong</div><div class="d">${esc_(s.ev.message)}</div></div></div>`);
    } else if (s.kind === 'tool') {
      html.push(toolStep(s));
    }
  }

  if (status === 'running') html.push(`<div class="step live"><span class="spin"></span><div class="d">agent is thinking…</div></div>`);
  return html.join('');
}

function toolStep(s) {
  const r = s.result;
  const pending = !r;
  switch (s.name) {
    case 'search_catalog': {
      const found = r?.results || [];
      const chips = found.slice(0, 3).map((p) => `<span class="pchip">${esc_(p.name)} · ₹${p.price_inr}</span>`).join('');
      return `<div class="step">${ico('search')}<div><div class="t">Searched “${esc_(s.args.query || 'catalog')}”${s.args.max_price_inr ? ` under ₹${s.args.max_price_inr}` : ''}</div>
        <div class="d">${pending ? '…' : `${found.length} match${found.length === 1 ? '' : 'es'}`}</div>${chips ? `<div class="chips">${chips}</div>` : ''}</div></div>`;
    }
    case 'get_product': {
      const p = r?.product;
      return `<div class="step">${ico('product')}<div><div class="t">Checked ${esc_(p ? p.name : s.args.id)}</div><div class="d">${p ? `₹${p.price_inr} · ${p.stock} in stock` : '…'}</div></div></div>`;
    }
    case 'declare_intent':
      return `<div class="step intent">${ico('intent')}<div><div class="t">Declared intent — ${esc_(s.args.product)} · ₹${s.args.amount_inr}</div><div class="d">“${esc_(s.args.reasoning)}”</div></div></div>`;
    case 'create_order':
      return `<div class="step">${ico('order')}<div><div class="t">Order created${r?.total_inr ? ` — ₹${r.total_inr}` : ''}</div><div class="d mono-sm">${esc_(r?.order_id || '…')}</div></div></div>`;
    case 'pay': {
      if (pending) return `<div class="step">${ico('pay')}<div><div class="t">Paying…</div></div></div>`;
      if (r.status === 'paid') return `<div class="step good">${ico('pay')}<div><div class="t">Paid ₹${r.amount_inr} ✓</div><div class="d mono-sm">${esc_(r.payment_id)} · ${esc_(s.args.method)}</div></div></div>`;
      if (r.status === 'failed') return `<div class="step bad">${ico('pay')}<div><div class="t">Payment failed — ${esc_(r.error)}</div><div class="d">${esc_(r.description || '')} ${r.attempts_left ? `· ${r.attempts_left} retry left` : '· no retries left'}</div></div></div>`;
      if (r.status === 'escalation_pending') return `<div class="step warn">${ico('pay')}<div><div class="t">Blocked by mandate</div><div class="d">${esc_(r.reason)}</div></div></div>`;
      if (r.status === 'denied') return `<div class="step bad">${ico('pay')}<div><div class="t">Payment denied</div><div class="d">${esc_(r.reason)}</div></div></div>`;
      return `<div class="step">${ico('pay')}<div><div class="t">Payment</div><div class="d">${esc_(JSON.stringify(r).slice(0, 160))}</div></div></div>`;
    }
    case 'wait_for_approval':
      return '';
    default:
      return `<div class="step">${ico('bot')}<div><div class="t">${esc_(s.name)}</div><div class="d">${esc_(JSON.stringify(r || s.args).slice(0, 160))}</div></div></div>`;
  }
}

function refreshMandateOptions(mandates) {
  const sel = $('#a-mandate');
  const current = sel.value;
  const active = mandates.filter((m) => m.state === 'ACTIVE');
  const opts = ['<option value="__auto__">✨ auto-create new mandate</option>']
    .concat(active.map((m) =>
      `<option value="${m.id}">${m.id} · ${inr(Math.max(0, m.cap_paise - m.spent_paise))} left · ${m.uses_left} uses</option>`));
  const html = opts.join('');
  if (sel.__last !== html) { sel.__last = html; sel.innerHTML = html; if ([...sel.options].some((o) => o.value === current)) sel.value = current; }
  $('#a-cap-wrap').style.display = sel.value === '__auto__' ? '' : 'none';
}
$('#a-mandate').addEventListener('change', () => {
  $('#a-cap-wrap').style.display = $('#a-mandate').value === '__auto__' ? '' : 'none';
});

$('#a-run').addEventListener('click', async () => {
  if (agentBusy) return;
  const task = $('#a-task').value.trim();
  if (!task) return alert('describe what the agent should buy');
  const sel = $('#a-mandate').value;
  const body = sel === '__auto__'
    ? { task, auto_cap: Number($('#a-cap').value) || 1500 }
    : { task, mandate_id: sel };

  const btn = $('#a-run');
  const box = $('#a-steps');
  agentBusy = true;
  btn.disabled = true; btn.textContent = 'Agent running…';
  box.hidden = false;
  box.innerHTML = `<div class="step live"><span class="spin"></span><div class="d">starting agent…</div></div>`;

  try {
    const { run_id, error } = await api.post('/api/agent/run', body);
    if (error) throw new Error(error);
    while (true) {
      await new Promise((r) => setTimeout(r, 1200));
      const run = await api.get(`/api/agent/run/${run_id}`);
      setHTML(box, renderSteps(run.events || [], run.status));
      box.scrollTop = box.scrollHeight;
      if (run.status !== 'running') {
        if (run.status === 'error' && !(run.events || []).some((e) => e.e === 'error')) {
          box.innerHTML += `<div class="step bad">${ico('bot')}<div><div class="t">Agent stopped unexpectedly</div><div class="d">${esc_((run.log || '').slice(-200) || 'no details')}</div></div></div>`;
        }
        break;
      }
    }
  } catch (e) {
    box.innerHTML += `<div class="step bad">${ico('bot')}<div><div class="t">Could not run agent</div><div class="d">${esc_(e.message)}</div></div></div>`;
  } finally {
    agentBusy = false;
    btn.disabled = false; btn.textContent = '▶ Run agent';
    refresh();
  }
});

// only touch the DOM when content actually changed — avoids replaying
// entrance animations on every poll
function setHTML(el, html) {
  if (el.__last === html) return;
  el.__last = html;
  el.innerHTML = html;
}

async function refresh() {
  try {
    const [mandates, escs, verify, orders] = await Promise.all([
      api.get('/api/m/mandates'),
      api.get('/api/m/escalations?status=PENDING'),
      api.get('/api/m/ledger/verify'),
      api.get('/api/s/orders').catch(() => []),
    ]);

    refreshMandateOptions(mandates);

    setHTML($('#mandates'), mandates.slice().reverse().map(mandateCard).join('') ||
      '<p class="empty">No mandates yet. Grant one above, then let the agent shop.</p>');

    setHTML($('#escalations'), escs.length
      ? escs.map(escCard).join('')
      : '<p class="empty">No pending escalations. The agent is inside its mandate.</p>');

    const badge = $('#chain-badge');
    badge.className = 'badge ' + (verify.intact ? 'ok' : 'bad');
    badge.innerHTML = verify.intact
      ? `<span class="dot"></span> ledger intact · signed + anchored · ${verify.count} events`
      : `<span class="dot"></span> ledger TAMPERED @${verify.broken_at} · ${verify.reason || ''}`;
    badge.title = verify.intact
      ? 'Every event is HMAC-signed with a key that is not in the ledger file, and the head hash is anchored separately so a truncation cannot hide either.'
      : String(verify.reason || '');

    setHTML($('#orders'), (orders || []).slice(-6).reverse().map((o) =>
      `<div class="card"><div class="order-line"><span>${o.lines.map((l) => l.name).join(', ')}</span>
       <b class="st-${o.status}">₹${o.total_inr} · ${o.status}</b></div>
       <div class="mono">${o.id}</div></div>`).join('') || '<p class="empty">No orders yet.</p>');

    const events = await api.get('/api/m/ledger');
    const el = $('#ledger');
    setHTML(el, events.slice(-80).reverse().map((ev) =>
      `<div class="ev ${ev.type}">
        <div class="seq">#${ev.seq}</div>
        <div>
          <div class="type">${ev.type.replaceAll('_', ' ')}</div>
          <div class="detail">${summarize(ev)}</div>
          <div class="hash">${ev.hash.slice(0, 18)}… ⇦ ${ev.prev_hash === 'GENESIS' ? 'GENESIS' : ev.prev_hash.slice(0, 18) + '…'} · ${ev.actor} · ${new Date(ev.ts).toLocaleTimeString()}</div>
        </div>
      </div>`).join('') || '<p class="empty">Ledger is empty. Every action will appear here, hash-linked.</p>');
  } catch { /* services may still be starting */ }
}

init().then(refresh);
setInterval(refresh, 1500);
