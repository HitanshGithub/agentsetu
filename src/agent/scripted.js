// Scripted (no-LLM) demo driver — exercises the exact same tool pipeline the
// LLM agent uses, deterministically. Useful for:
//   - offline demos when the free LLM endpoint is rate-limited
//   - judges reproducing the flows without any API key
//
//   npm run demo:scripted -- happy      buy a hoodie within mandate
//   npm run demo:scripted -- escalate   attempt an over-cap purchase -> human gate
//   npm run demo:scripted -- failure    forced decline -> bounded retry -> recovery
//   npm run demo:scripted -- attack     run the four attacks the gate is built to stop
import 'dotenv/config';

const MANDATE = `http://localhost:${process.env.MANDATE_PORT || 4001}`;
const STORE = `http://localhost:${process.env.STOREFRONT_PORT || 4100}`;

async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const tool = async (name, args) => (await post(STORE, `/tools/${name}`, { args })).body;
const postJson = async (base, path, body) => (await post(base, path, body)).body;
const log = (s) => console.log(s);

async function declareIntent(product, amount_inr, reasoning, mandate_id) {
  await postJson(MANDATE, '/ledger', { type: 'INTENT_DECLARED', data: { product, amount_inr, reasoning, mandate_id }, actor: 'buyer-agent(scripted)' });
}

async function makeMandate(merchant, cap_inr, extra = {}) {
  const m = await postJson(MANDATE, '/mandates', { merchant, cap_inr, category: 'any', expiry_minutes: 60, max_uses: 2, ...extra });
  log(`🔐 mandate ${m.id} — cap ₹${cap_inr}${extra.category && extra.category !== 'any' ? ` · ${extra.category} only` : ''}`);
  return m;
}

const scenario = process.argv[2] || 'happy';

async function main() {
  const manifest = await (await fetch(`${STORE}/manifest`)).json();
  const merchant = manifest.merchant;
  log(`🛍  merchant: ${merchant} (orders: ${manifest.payment_mode}, capture: ${manifest.capture}) — scenario: ${scenario}\n`);

  if (scenario === 'happy') {
    const m = await makeMandate(merchant, 1500);
    const found = await tool('search_catalog', { query: 'black hoodie', max_price_inr: 1500 });
    const pick = found.results[0];
    log(`🔎 picked: ${pick.name} ₹${pick.price_inr}`);
    const order = await tool('create_order', { items: [{ product_id: pick.id, qty: 1 }], mandate_id: m.id });
    await declareIntent(pick.name, order.total_inr, 'cheapest in-stock black hoodie within budget', m.id);
    const paid = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    log(`💸 ${JSON.stringify(paid)}`);
  }

  if (scenario === 'escalate') {
    const m = await makeMandate(merchant, 1500);
    const { product: pick } = await tool('get_product', { id: 'p3' }); // Premium Zip Hoodie ₹2799 > cap
    const order = await tool('create_order', { items: [{ product_id: pick.id, qty: 1 }], mandate_id: m.id });
    await declareIntent(pick.name, order.total_inr, 'user asked for the premium zip hoodie despite ₹1500 cap', m.id);
    const first = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    log(`🚧 ${JSON.stringify(first)}`);
    if (first.status === 'escalation_pending') {
      log('⏳ waiting for human approve/deny in the control panel (2 min timeout)...');
      for (let i = 0; i < 60; i++) {
        const esc = await (await fetch(`${MANDATE}/escalations/${first.escalation_id}`)).json();
        if (esc.status === 'APPROVED') {
          const paid = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay', escalation_id: esc.id });
          log(`💸 after approval: ${JSON.stringify(paid)}`);
          return finish();
        }
        if (esc.status === 'DENIED') { log('🛑 human denied — purchase abandoned, mandate intact.'); return finish(); }
        await new Promise((r) => setTimeout(r, 2000));
      }
      log('⌛ no decision — giving up.');
    }
  }

  if (scenario === 'failure') {
    const m = await makeMandate(merchant, 1500);
    const found = await tool('search_catalog', { query: 'black hoodie', max_price_inr: 1500 });
    const pick = found.results[0];
    const order = await tool('create_order', { items: [{ product_id: pick.id, qty: 1 }], mandate_id: m.id });
    await declareIntent(pick.name, order.total_inr, 'demo of graceful failure handling', m.id);
    log('💳 attempt 1: test_card_declined (forced failure)');
    const fail = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'test_card_declined' });
    log(`   ↳ ${JSON.stringify(fail)}`);
    const after = await (await fetch(`${MANDATE}/mandates/${m.id}`)).json();
    log(`   ↳ hold released: ₹${after.remaining_paise / 100} of ₹${after.cap_paise / 100} still spendable`);
    await postJson(MANDATE, '/ledger', { type: 'RETRY_POLICY', data: { order_id: order.order_id, decision: 'retry once with alternate method', attempts_left: fail.attempts_left }, actor: 'buyer-agent(scripted)' });
    log('🔁 bounded retry: attempt 2 via upi_reserve_pay');
    const paid = await tool('pay', { order_id: order.order_id, mandate_id: m.id, method: 'upi_reserve_pay' });
    log(`   ↳ ${JSON.stringify(paid)}`);
    log('🧾 the full fail->policy->recover chain is on the ledger, signed and hash-linked.');
  }

  // Four things a misbehaving or hijacked agent would try. Each one is refused
  // by deterministic code, and each refusal lands on the ledger.
  if (scenario === 'attack') {
    log('1) pay with no mandate at all');
    const o0 = await tool('create_order', { items: [{ product_id: 'p5' }] });
    const challenge = await post(STORE, '/tools/pay', { args: { order_id: o0.order_id, method: 'upi_reserve_pay' } });
    log(`   ↳ HTTP ${challenge.status} · ${challenge.body.title} · needs ${challenge.body.accepts?.[0]?.required_fields?.join(', ')}\n`);

    log('2) smuggle an accessories item into an apparel-only mandate');
    const m1 = await makeMandate(merchant, 5000, { category: 'apparel' });
    const o1 = await tool('create_order', { items: [{ product_id: 'p1' }, { product_id: 'p6' }] });
    const r1 = await tool('pay', { order_id: o1.order_id, mandate_id: m1.id, method: 'upi_reserve_pay' });
    log(`   ↳ ${r1.status} · ${r1.reason}\n`);

    log('3) buy more retries by opening a fresh order each time');
    const m2 = await makeMandate(merchant, 5000, { max_uses: 1 });
    for (let i = 1; i <= 4; i++) {
      const o = await tool('create_order', { items: [{ product_id: 'p5' }] });
      const r = await tool('pay', { order_id: o.order_id, mandate_id: m2.id, method: 'test_card_declined' });
      log(`   ↳ order ${i}: ${r.status}${r.reason ? ' · ' + r.reason : ''}`);
    }
    log('');

    log('4) spend the same headroom twice, at the same moment');
    const m3 = await makeMandate(merchant, 2000, { max_uses: 4, max_attempts: 8 });
    const [a, b] = await Promise.all([
      tool('create_order', { items: [{ product_id: 'p2' }] }),
      tool('create_order', { items: [{ product_id: 'p2' }] }),
    ]);
    const [ra, rb] = await Promise.all([
      tool('pay', { order_id: a.order_id, mandate_id: m3.id, method: 'upi_reserve_pay' }),
      tool('pay', { order_id: b.order_id, mandate_id: m3.id, method: 'upi_reserve_pay' }),
    ]);
    const settled = [ra, rb].filter((r) => r.status === 'paid').length;
    const m3after = await (await fetch(`${MANDATE}/mandates/${m3.id}`)).json();
    log(`   ↳ ${settled} of 2 settled · spent ₹${m3after.spent_paise / 100} of a ₹${m3after.cap_paise / 100} cap\n`);
    log('Every refusal above is a ledger event. Nothing here relies on the model behaving.');
  }

  await finish();
}

async function finish() {
  const v = await (await fetch(`${MANDATE}/ledger/verify`)).json();
  console.log(`\n🔗 ledger verify: intact=${v.intact} signed=${v.signed} anchored=${v.anchored} events=${v.count}`);
}

main().catch((e) => { console.error('scripted demo error:', e.message); process.exit(1); });
