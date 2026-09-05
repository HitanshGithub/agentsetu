// Mandate Engine — the deterministic money gate, modeled on UPI Reserve Pay:
// one-time consent, per-merchant spend cap, expiry, bounded uses, instant revocation.
// Runs as its own process so the LLM agent literally cannot bypass it.
//
// What the gate enforces, in order, on every single payment:
//   1. mandate exists and is ACTIVE (not revoked / expired / exhausted)
//   2. mandate belongs to this merchant
//   3. attempt budget not exhausted  <- bounds retries per MANDATE, not per order,
//      so an agent cannot buy itself fresh retries by creating a new order
//   4. every line item's category is inside the mandate's category
//   5. amount fits inside cap - spent - HELD
//      (held = funds reserved by an in-flight payment, so two concurrent
//       payments cannot both pass the cap check and then both settle)
// Anything outside 4 or 5 escalates to a human. 1, 2 and 3 are hard denies.
import 'dotenv/config';
import express from 'express';
import { JsonStore, id, appendLedger, readLedger, verifyLedger, signPayload, ledgerKeySource } from '../lib/store.js';

const app = express();
app.use(express.json());

const mandates = new JsonStore('mandates');
const escalations = new JsonStore('escalations');
const holds = new JsonStore('holds');

// A human-approved escalation is a cheque, not a standing order: it expires.
const ESCALATION_TTL_MS = 15 * 60_000;
// A hold from a payment that never reported back is released so funds are not
// locked forever by a crashed storefront.
const HOLD_TTL_MS = 5 * 60_000;

function mandateState(m) {
  if (m.revoked) return 'REVOKED';
  if (Date.now() > new Date(m.expires_at).getTime()) return 'EXPIRED';
  if (m.uses_left <= 0) return 'EXHAUSTED';
  if (m.attempts_used >= m.max_attempts) return 'ATTEMPTS_EXHAUSTED';
  return 'ACTIVE';
}

function remainingPaise(m) {
  return m.cap_paise - m.spent_paise - (m.held_paise || 0);
}

function publicMandate(m) {
  return { ...m, state: mandateState(m), remaining_paise: remainingPaise(m) };
}

// Release holds whose payment never came back. Runs before every check so the
// sweep is deterministic and needs no timer.
function sweepStaleHolds() {
  for (const h of holds.all()) {
    if (h.status !== 'HELD') continue;
    if (Date.now() - new Date(h.created_at).getTime() < HOLD_TTL_MS) continue;
    const m = mandates.get(h.mandate_id);
    if (m) {
      m.held_paise = Math.max(0, (m.held_paise || 0) - h.amount_paise);
      mandates.put(m.id, m);
    }
    h.status = 'EXPIRED';
    holds.put(h.id, h);
    appendLedger('HOLD_RELEASED', { hold_id: h.id, mandate_id: h.mandate_id, amount_paise: h.amount_paise, reason: 'hold expired without settlement' }, 'mandate-engine');
  }
}

// ---- Mandates ----
app.post('/mandates', (req, res) => {
  const { merchant, cap_inr, category, expiry_minutes = 60, max_uses = 1, max_attempts, owner = 'demo-user' } = req.body;
  if (!merchant || !cap_inr) return res.status(400).json({ error: 'merchant and cap_inr required' });
  const uses = Math.max(1, Number(max_uses) || 1);
  const m = {
    id: id('mdt'),
    merchant,
    cap_paise: Math.round(cap_inr * 100),
    spent_paise: 0,
    held_paise: 0,
    category: category || 'any',
    owner,
    max_uses: uses,
    uses_left: uses,
    // Every ALLOW spends one attempt, successful or not. The default budget
    // gives each intended purchase exactly one retry and nothing more.
    max_attempts: Math.max(1, Number(max_attempts) || uses * 2),
    attempts_used: 0,
    revoked: false,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiry_minutes * 60_000).toISOString(),
  };
  mandates.put(m.id, m);
  appendLedger('MANDATE_CREATED', { mandate_id: m.id, merchant, cap_inr, category: m.category, max_uses: uses, max_attempts: m.max_attempts, expiry_minutes }, owner);
  res.json(publicMandate(m));
});

app.get('/mandates', (_req, res) => { sweepStaleHolds(); res.json(mandates.all().map(publicMandate)); });
app.get('/mandates/:id', (req, res) => {
  const m = mandates.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(publicMandate(m));
});

// AP2-shaped view of the same mandate.
// Google's AP2 and NPCI's UAP both express consent as a signed, constrained,
// expiring authorization rather than a stored credential. This endpoint renders
// our internal mandate in that shape so an AP2-speaking buyer agent can read it.
// The signature is an HMAC over the canonical payload: demo-grade, single trusted
// issuer. Production would use an asymmetric key the buyer can verify alone.
app.get('/mandates/:id/ap2', (req, res) => {
  const m = mandates.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const payload = {
    type: 'PaymentMandate',
    id: m.id,
    issued_at: m.created_at,
    expires_at: m.expires_at,
    principal: { id: m.owner, role: 'human-payer' },
    agent: { id: 'agentsetu-buyer-agent', role: 'delegate' },
    merchant: { name: m.merchant },
    constraints: {
      max_amount: { currency: 'INR', value: (m.cap_paise / 100).toFixed(2) },
      remaining: { currency: 'INR', value: (Math.max(0, remainingPaise(m)) / 100).toFixed(2) },
      category: m.category,
      max_uses: m.max_uses,
      uses_left: m.uses_left,
      max_attempts: m.max_attempts,
      attempts_used: m.attempts_used,
    },
    state: mandateState(m),
    revocable: true,
  };
  res.json({
    protocol: 'ap2-mandate-shape/preview',
    note: 'Follows AP2 mandate semantics (constrained, expiring, revocable, signed). The signature is HMAC for the demo, not an AP2-conformant asymmetric signature.',
    mandate: payload,
    signature: { alg: 'HMAC-SHA256', key_source: ledgerKeySource, value: signPayload(payload) },
  });
});

app.post('/mandates/:id/revoke', (req, res) => {
  const m = mandates.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  m.revoked = true;
  mandates.put(m.id, m);
  appendLedger('MANDATE_REVOKED', { mandate_id: m.id, merchant: m.merchant }, m.owner);
  res.json(publicMandate(m));
});

// ---- The gate: every payment must pass here ----
app.post('/check', (req, res) => {
  sweepStaleHolds();
  const { mandate_id, merchant, amount_paise, category, categories, intent, escalation_id, order_id } = req.body;
  const m = mandates.get(mandate_id);

  // Every line item's category, not just the first one. Checking only lines[0]
  // let an off-category item ride along inside a multi-item order.
  const cats = [...new Set((categories && categories.length ? categories : [category]).filter(Boolean))];

  const deny = (reason) => {
    appendLedger('MANDATE_CHECK', { mandate_id, merchant, amount_paise, order_id, decision: 'DENY', reason }, 'mandate-engine');
    return res.json({ decision: 'DENY', reason });
  };

  if (!m) return deny('mandate does not exist');
  if (!Number.isFinite(amount_paise) || amount_paise <= 0) return deny('amount must be a positive number of paise');
  const state = mandateState(m);
  if (state === 'ATTEMPTS_EXHAUSTED') return deny(`attempt budget exhausted (${m.attempts_used}/${m.max_attempts} used on this mandate)`);
  if (state !== 'ACTIVE') return deny(`mandate is ${state}`);
  if (m.merchant !== merchant) return deny(`mandate is for merchant "${m.merchant}", not "${merchant}"`);

  // Reserve funds and spend one attempt. Only ever called on an ALLOW.
  const allow = (reason) => {
    m.attempts_used += 1;
    m.held_paise = (m.held_paise || 0) + amount_paise;
    mandates.put(m.id, m);
    const hold = {
      id: id('hold'), mandate_id, order_id: order_id || null, amount_paise,
      status: 'HELD', created_at: new Date().toISOString(),
    };
    holds.put(hold.id, hold);
    appendLedger('MANDATE_CHECK', {
      mandate_id, merchant, amount_paise, order_id, decision: 'ALLOW', reason,
      hold_id: hold.id, attempts_used: m.attempts_used, attempts_left: m.max_attempts - m.attempts_used,
    }, 'mandate-engine');
    return res.json({
      decision: 'ALLOW', reason, hold_id: hold.id,
      attempts_left: m.max_attempts - m.attempts_used,
    });
  };

  // A previously approved escalation authorizes this exact amount, once, briefly.
  if (escalation_id) {
    const esc = escalations.get(escalation_id);
    if (!esc) return deny('escalation not found');
    if (esc.status !== 'APPROVED') return deny(`escalation is ${esc.status}, not APPROVED`);
    if (esc.consumed) return deny('escalation already used');
    if (esc.mandate_id !== mandate_id) return deny('escalation belongs to a different mandate');
    if (esc.amount_paise !== amount_paise) return deny(`escalation authorizes exactly ₹${(esc.amount_paise / 100).toFixed(0)}, not ₹${(amount_paise / 100).toFixed(0)}`);
    if (esc.order_id && order_id && esc.order_id !== order_id) return deny('escalation was approved for a different order');
    if (Date.now() - new Date(esc.decided_at || esc.created_at).getTime() > ESCALATION_TTL_MS) return deny('escalation approval has expired');
    esc.consumed = true;
    escalations.put(esc.id, esc);
    return allow(`human-approved escalation ${escalation_id}`);
  }

  const remaining = remainingPaise(m);
  const overCap = amount_paise > remaining;
  const offCategory = m.category !== 'any' && cats.some((c) => c !== m.category);
  if (overCap || offCategory) {
    const reason = overCap
      ? `amount ₹${(amount_paise / 100).toFixed(0)} exceeds remaining cap ₹${(Math.max(0, remaining) / 100).toFixed(0)}`
      : `categories [${cats.join(', ')}] outside mandate category "${m.category}"`;
    const esc = {
      id: id('esc'), mandate_id, merchant, amount_paise, categories: cats,
      order_id: order_id || null, intent: intent || null, reason,
      status: 'PENDING', consumed: false, created_at: new Date().toISOString(),
    };
    escalations.put(esc.id, esc);
    appendLedger('ESCALATION_RAISED', { escalation_id: esc.id, mandate_id, merchant, amount_paise, order_id, reason, intent }, 'mandate-engine');
    return res.json({ decision: 'ESCALATE', reason, escalation_id: esc.id });
  }

  return allow('within mandate');
});

// Settle a hold after a successful payment: held -> spent.
app.post('/consume', (req, res) => {
  const { mandate_id, amount_paise, payment_id, hold_id } = req.body;
  const m = mandates.get(mandate_id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const hold = hold_id ? holds.get(hold_id) : null;
  if (hold && hold.status === 'HELD') {
    m.held_paise = Math.max(0, (m.held_paise || 0) - hold.amount_paise);
    hold.status = 'SETTLED';
    hold.payment_id = payment_id;
    holds.put(hold.id, hold);
  }
  m.spent_paise += amount_paise;
  m.uses_left -= 1;
  mandates.put(m.id, m);
  appendLedger('MANDATE_CONSUMED', { mandate_id, amount_paise, payment_id, hold_id: hold_id || null, uses_left: m.uses_left, spent_paise: m.spent_paise }, 'mandate-engine');
  res.json(publicMandate(m));
});

// Release a hold when the payment failed, so the money is spendable again.
app.post('/release', (req, res) => {
  const { hold_id, reason } = req.body;
  const hold = holds.get(hold_id);
  if (!hold) return res.status(404).json({ error: 'hold not found' });
  if (hold.status !== 'HELD') return res.json({ ok: true, note: `hold already ${hold.status}` });
  const m = mandates.get(hold.mandate_id);
  if (m) {
    m.held_paise = Math.max(0, (m.held_paise || 0) - hold.amount_paise);
    mandates.put(m.id, m);
  }
  hold.status = 'RELEASED';
  holds.put(hold.id, hold);
  appendLedger('HOLD_RELEASED', { hold_id, mandate_id: hold.mandate_id, amount_paise: hold.amount_paise, reason: reason || 'payment did not settle' }, 'mandate-engine');
  res.json({ ok: true, mandate: m ? publicMandate(m) : null });
});

app.get('/holds', (_req, res) => res.json(holds.all()));

// ---- Escalations (human approve/deny) ----
app.get('/escalations', (req, res) => {
  let list = escalations.all();
  if (req.query.status) list = list.filter((e) => e.status === req.query.status);
  res.json(list.sort((a, b) => a.created_at < b.created_at ? 1 : -1));
});
app.get('/escalations/:id', (req, res) => {
  const e = escalations.get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  res.json(e);
});
app.post('/escalations/:id/decide', (req, res) => {
  const e = escalations.get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  if (e.status !== 'PENDING') return res.status(400).json({ error: `already ${e.status}` });
  e.status = req.body.approve ? 'APPROVED' : 'DENIED';
  e.decided_at = new Date().toISOString();
  escalations.put(e.id, e);
  appendLedger('ESCALATION_DECIDED', { escalation_id: e.id, decision: e.status, mandate_id: e.mandate_id, amount_paise: e.amount_paise, valid_for_minutes: ESCALATION_TTL_MS / 60000 }, 'human');
  res.json(e);
});

// ---- Ledger ----
app.post('/ledger', (req, res) => {
  const { type, data, actor } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  res.json(appendLedger(type, data, actor));
});
app.get('/ledger', (req, res) => {
  const events = readLedger();
  const since = Number(req.query.since || 0);
  res.json(events.filter((e) => e.seq > since));
});
app.get('/ledger/verify', (_req, res) => res.json(verifyLedger()));

const port = process.env.MANDATE_PORT || 4001;
app.listen(port, () => console.log(`[mandate-engine] listening on :${port} (ledger: HMAC-signed chain + head anchor, key from ${ledgerKeySource})`));
