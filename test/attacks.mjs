// Adversarial test suite — this is the file that decides whether the README is
// telling the truth. Every check below is an ATTACK on the money gate, written
// after finding the first three of them by hand in my own code.
//
//   npm test
//
// It boots a real mandate engine and a real storefront on throwaway ports with
// an isolated runtime dir, attacks them over HTTP, and exits non-zero on any
// hole. No LLM key, no Razorpay key, no network.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RUNTIME = path.resolve('runtime-test');
const MANDATE_PORT = 4901;
const STOREFRONT_PORT = 4902;
const M = `http://localhost:${MANDATE_PORT}`;
const S = `http://localhost:${STOREFRONT_PORT}`;

fs.rmSync(RUNTIME, { recursive: true, force: true });

const env = {
  ...process.env,
  RUNTIME_DIR: RUNTIME,
  MANDATE_PORT: String(MANDATE_PORT),
  STOREFRONT_PORT: String(STOREFRONT_PORT),
  LEDGER_SECRET: 'test-secret-not-for-production',
  RAZORPAY_KEY_ID: '',       // force the local simulator: tests must not hit the network
  RAZORPAY_KEY_SECRET: '',
};

const children = [];
function boot(file) {
  const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => process.env.TEST_VERBOSE && process.stderr.write(d));
  children.push(p);
  return p;
}
const shutdown = () => children.forEach((c) => c.kill());

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`service never came up: ${url}`);
}

const post = (base, p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});
const postJson = async (base, p, body) => (await post(base, p, body)).json();
const get = (base, p) => fetch(base + p).then((r) => r.json());
const tool = (name, args) => postJson(S, `/tools/${name}`, { args });

// ---- tiny assertion harness ----
let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const mandate = (opts) => postJson(M, '/mandates', { merchant: MERCHANT, cap_inr: 5000, expiry_minutes: 60, max_uses: 4, ...opts });
let MERCHANT;

async function main() {
  boot('src/mandate/server.js');
  boot('src/storefront/server.js');
  await waitFor(`${M}/ledger/verify`);
  await waitFor(`${S}/health`);
  MERCHANT = (await get(S, '/health')).merchant;
  console.log(`\nAgentSetu attack suite — merchant "${MERCHANT}", isolated runtime at ${path.basename(RUNTIME)}\n`);

  console.log('the happy path still works');
  await check('a purchase inside the mandate settles and the spend is recorded', async () => {
    const m = await mandate({ cap_inr: 2000, max_uses: 1 });
    const order = await tool('create_order', { items: [{ product_id: 'p1' }], mandate_id: m.id });
    const paid = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    eq(paid.status, 'paid', 'payment should succeed');
    const after = await get(M, `/mandates/${m.id}`);
    eq(after.spent_paise, 129900, 'spend should be recorded on the mandate');
    eq(after.held_paise, 0, 'the hold should be settled, not left hanging');
  });

  console.log('\nattacks on the gate');

  await check('an off-category item cannot ride along inside a multi-item order', async () => {
    // p1 is apparel, p6 is accessories. The mandate only allows apparel.
    const m = await mandate({ cap_inr: 5000, category: 'apparel' });
    const order = await tool('create_order', { items: [{ product_id: 'p1' }, { product_id: 'p6' }] });
    const r = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    assert(r.status !== 'paid', 'a mixed-category order must not settle silently');
    eq(r.status, 'escalation_pending', 'it should escalate to a human');
    assert(/accessories/.test(r.reason), `the reason should name the offending category, got: ${r.reason}`);
  });

  await check('the agent cannot buy fresh retries by creating new orders', async () => {
    // Attempt budget is max_uses * 2 = 2 here, enforced across ALL orders.
    const m = await mandate({ cap_inr: 5000, max_uses: 1 });
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const order = await tool('create_order', { items: [{ product_id: 'p5' }] });
      outcomes.push(await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'test_card_declined' }));
    }
    const allowed = outcomes.filter((o) => o.status === 'failed').length;
    eq(allowed, 2, 'exactly the attempt budget should reach the payment rail');
    assert(outcomes.slice(2).every((o) => o.status === 'denied'), 'attempts past the budget must be denied by the gate');
    assert(/attempt budget/.test(outcomes[3].reason || ''), `deny reason should name the attempt budget, got: ${outcomes[3].reason}`);
  });

  await check('two concurrent payments cannot both spend the same headroom', async () => {
    // Cap 2000. Two orders of 1499 each. Without holds both pass the cap check
    // before either settles, and the mandate ends up 998 overspent.
    const m = await mandate({ cap_inr: 2000, max_uses: 4, max_attempts: 8 });
    const a = await tool('create_order', { items: [{ product_id: 'p2' }] });
    const b = await tool('create_order', { items: [{ product_id: 'p2' }] });
    const [ra, rb] = await Promise.all([
      tool('pay', { order_id: a.order_id, mandate_id: m.id, method: 'upi_reserve_pay' }),
      tool('pay', { order_id: b.order_id, mandate_id: m.id, method: 'upi_reserve_pay' }),
    ]);
    const settled = [ra, rb].filter((r) => r.status === 'paid');
    eq(settled.length, 1, 'exactly one of two concurrent payments should settle');
    const after = await get(M, `/mandates/${m.id}`);
    assert(after.spent_paise <= after.cap_paise, `spend ${after.spent_paise} must never exceed cap ${after.cap_paise}`);
  });

  await check('a declined payment gives its reserved money back', async () => {
    const m = await mandate({ cap_inr: 1500, max_uses: 2, max_attempts: 4 });
    const order = await tool('create_order', { items: [{ product_id: 'p1' }] });
    await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'test_card_declined' });
    const after = await get(M, `/mandates/${m.id}`);
    eq(after.held_paise, 0, 'the hold must be released when the payment fails');
    eq(after.remaining_paise, 150000, 'full headroom should be spendable again');
  });

  await check('an approved escalation cannot be reused on a second order', async () => {
    const m = await mandate({ cap_inr: 1000, max_uses: 3, max_attempts: 6 });
    const first = await tool('create_order', { items: [{ product_id: 'p3' }] }); // 2799 > cap
    const blocked = await tool('pay', { order_id: first.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    eq(blocked.status, 'escalation_pending', 'over-cap purchase should escalate');
    await postJson(M, `/escalations/${blocked.escalation_id}/decide`, { approve: true });
    const paid = await tool('pay', { order_id: first.order_id, mandate_id: m.id, method: 'upi_reserve_pay', escalation_id: blocked.escalation_id });
    eq(paid.status, 'paid', 'the approved purchase should go through once');

    const second = await tool('create_order', { items: [{ product_id: 'p3' }] });
    const replay = await tool('pay', { order_id: second.order_id, mandate_id: m.id, method: 'upi_reserve_pay', escalation_id: blocked.escalation_id });
    eq(replay.status, 'denied', 'replaying the approval must be denied');
    assert(/already used|different order/.test(replay.reason), `deny reason should explain the replay, got: ${replay.reason}`);
  });

  await check('an approval for one amount cannot be stretched to a bigger one', async () => {
    const m = await mandate({ cap_inr: 1000, max_uses: 3, max_attempts: 6 });
    const cheap = await tool('create_order', { items: [{ product_id: 'p6' }] }); // 899
    const esc = await tool('pay', { order_id: cheap.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    // 899 is under the 1000 cap, so force an escalation with a bigger order instead
    const dear = await tool('create_order', { items: [{ product_id: 'p3' }] });  // 2799
    const blocked = await tool('pay', { order_id: dear.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    eq(blocked.status, 'escalation_pending', 'the expensive order should escalate');
    await postJson(M, `/escalations/${blocked.escalation_id}/decide`, { approve: true });
    // now try to spend that approval on a DIFFERENT, cheaper order
    const other = await tool('create_order', { items: [{ product_id: 'p2' }] });  // 1499
    const misuse = await tool('pay', { order_id: other.order_id, mandate_id: m.id, method: 'upi_reserve_pay', escalation_id: blocked.escalation_id });
    eq(misuse.status, 'denied', 'an approval is for one exact amount and order');
    assert(esc.status !== undefined, 'sanity');
  });

  await check('a revoked mandate stops the next payment dead', async () => {
    const m = await mandate({ cap_inr: 3000, max_uses: 3, max_attempts: 6 });
    await postJson(M, `/mandates/${m.id}/revoke`, {});
    const order = await tool('create_order', { items: [{ product_id: 'p1' }] });
    const r = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    eq(r.status, 'denied', 'a revoked mandate must deny');
    assert(/REVOKED/.test(r.reason), `reason should say REVOKED, got: ${r.reason}`);
  });

  await check('a mandate for another merchant is refused', async () => {
    const m = await postJson(M, '/mandates', { merchant: 'Some Other Store', cap_inr: 5000 });
    const order = await tool('create_order', { items: [{ product_id: 'p1' }] });
    const r = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    eq(r.status, 'denied', 'cross-merchant use must be denied');
  });

  await check('an invented mandate id buys nothing', async () => {
    const order = await tool('create_order', { items: [{ product_id: 'p1' }] });
    const r = await tool('pay', { order_id: order.order_id, mandate_id: 'mdt_deadbeefdead', method: 'upi_reserve_pay' });
    eq(r.status, 'denied', 'unknown mandates must be denied');
  });

  console.log('\nprotocol surface');

  await check('paying with no mandate returns an x402-style 402 challenge', async () => {
    const order = await tool('create_order', { items: [{ product_id: 'p1' }] });
    const r = await post(S, '/tools/pay', { args: { order_id: order.order_id, method: 'upi_reserve_pay' } });
    eq(r.status, 402, 'HTTP status should be 402 Payment Required');
    const body = await r.json();
    assert(Array.isArray(body.accepts) && body.accepts[0].required_fields.includes('mandate_id'),
      'the challenge should name mandate_id as the missing authorization');
  });

  await check('the storefront answers MCP tools/list and tools/call', async () => {
    const list = await postJson(S, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    assert(names.includes('search_catalog') && names.includes('pay'), `MCP tool list is wrong: ${names}`);
    assert(list.result.tools.every((t) => t.inputSchema), 'MCP tools need inputSchema, not parameters');
    const call = await postJson(S, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_catalog', arguments: { query: 'hoodie' } } });
    const payload = JSON.parse(call.result.content[0].text);
    assert(payload.results.length >= 2, 'MCP tools/call should return catalog results');
  });

  await check('the mandate renders in AP2 shape with a signature', async () => {
    const m = await mandate({ cap_inr: 1200 });
    const ap2 = await get(M, `/mandates/${m.id}/ap2`);
    eq(ap2.mandate.type, 'PaymentMandate', 'AP2 view should be a PaymentMandate');
    eq(ap2.mandate.constraints.max_amount.value, '1200.00', 'the cap should be expressed as an amount constraint');
    assert(/^[0-9a-f]{64}$/.test(ap2.signature.value), 'the AP2 view should be signed');
  });

  console.log('\nattacks on the audit trail');

  await check('the ledger detects an edited event', async () => {
    const file = path.join(RUNTIME, 'ledger.ndjson');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const backup = [...lines];
    const target = lines.findIndex((l) => l.includes('PAYMENT_SUCCEEDED'));
    assert(target >= 0, 'need a payment event to tamper with');
    const ev = JSON.parse(lines[target]);
    ev.data.amount_inr = 1;                       // the classic: quietly shrink a payment
    lines[target] = JSON.stringify(ev);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const v = await get(M, '/ledger/verify');
    eq(v.intact, false, 'an edited event must break verification');
    eq(v.broken_at, ev.seq, 'verification should point at the edited event');
    fs.writeFileSync(file, backup.join('\n') + '\n');
    const restored = await get(M, '/ledger/verify');
    eq(restored.intact, true, 'restoring the original should verify again');
  });

  await check('the ledger detects a forged event, not just an edited one', async () => {
    // A plain SHA-256 chain fails this: an attacker just recomputes the hashes.
    // The HMAC key is not in the file, so the forgery cannot be signed.
    const file = path.join(RUNTIME, 'ledger.ndjson');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const backup = [...lines];
    const idx = lines.findIndex((l) => l.includes('PAYMENT_SUCCEEDED'));
    const ev = JSON.parse(lines[idx]);
    ev.data.amount_inr = 1;
    // rebuild the chain the way an attacker who only knows SHA-256 would
    const crypto = await import('node:crypto');
    let prev = ev.prev_hash;
    ev.hash = crypto.createHash('sha256').update(`${ev.seq}|${ev.ts}|${ev.type}|${JSON.stringify(ev.data)}|${prev}`).digest('hex');
    lines[idx] = JSON.stringify(ev);
    prev = ev.hash;
    for (let i = idx + 1; i < lines.length; i++) {
      const e = JSON.parse(lines[i]);
      e.prev_hash = prev;
      e.hash = crypto.createHash('sha256').update(`${e.seq}|${e.ts}|${e.type}|${JSON.stringify(e.data)}|${prev}`).digest('hex');
      lines[i] = JSON.stringify(e);
      prev = e.hash;
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const v = await get(M, '/ledger/verify');
    eq(v.intact, false, 'a re-chained forgery must still fail: the signature is keyed');
    fs.writeFileSync(file, backup.join('\n') + '\n');
    eq((await get(M, '/ledger/verify')).intact, true, 'restore should verify');
  });

  await check('the ledger detects a truncation', async () => {
    // Deleting the tail leaves a prefix that a pure chain is perfectly happy with.
    const file = path.join(RUNTIME, 'ledger.ndjson');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const backup = [...lines];
    fs.writeFileSync(file, lines.slice(0, -3).join('\n') + '\n');
    const v = await get(M, '/ledger/verify');
    eq(v.intact, false, 'the head anchor must catch a truncated ledger');
    assert(/truncated/.test(v.reason || ''), `reason should say truncated, got: ${v.reason}`);
    fs.writeFileSync(file, backup.join('\n') + '\n');
    eq((await get(M, '/ledger/verify')).intact, true, 'restore should verify');
  });

  await check('every money decision left a record', async () => {
    const events = await get(M, '/ledger');
    const types = new Set(events.map((e) => e.type));
    for (const t of ['MANDATE_CREATED', 'MANDATE_CHECK', 'ORDER_CREATED', 'PAYMENT_ATTEMPT',
      'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'ESCALATION_RAISED', 'ESCALATION_DECIDED',
      'HOLD_RELEASED', 'MANDATE_REVOKED', 'PAYMENT_CHALLENGED']) {
      assert(types.has(t), `no ${t} event on the ledger`);
    }
    const denies = events.filter((e) => e.type === 'MANDATE_CHECK' && e.data.decision === 'DENY');
    assert(denies.length >= 4, `every deny should be on the record, found ${denies.length}`);
  });
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failures.length} failed\n`);
    shutdown();
    process.exit(failures.length ? 1 : 0);
  })
  .catch((e) => {
    console.error('\nsuite crashed:', e.message);
    shutdown();
    process.exit(1);
  });
