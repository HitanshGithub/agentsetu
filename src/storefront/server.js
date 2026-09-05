// Generated merchant storefront — the merchant's catalog, exposed as agent tools.
//
// Three ways in, one implementation behind them:
//   GET  /manifest        human/agent-readable tool list (agentsetu-tools/1)
//   POST /tools/:name     plain HTTP invocation
//   POST /mcp             JSON-RPC 2.0 in MCP shape: initialize, tools/list, tools/call
//
// Money rules enforced here, before anything reaches the mandate engine:
//   - pay without a mandate returns HTTP 402 with a machine-readable challenge
//     telling the agent exactly what authorization it must present (x402 shape)
//   - payment attempts are bounded per order AND per mandate
//   - a failed payment releases its hold, so a decline does not silently eat budget
// Every money action is gated by the mandate engine and written to the signed ledger.
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore, id } from '../lib/store.js';
import * as rzp from './razorpay.js';

const MANDATE = `http://localhost:${process.env.MANDATE_PORT || 4001}`;
const app = express();
app.use(express.json());

const merchantsDir = path.resolve('merchants');
const stores = Object.fromEntries(
  fs.readdirSync(merchantsDir).filter((f) => f.endsWith('.json'))
    .map((f) => { const s = JSON.parse(fs.readFileSync(path.join(merchantsDir, f), 'utf8')); return [s.slug, s]; })
);
const defaultSlug = Object.keys(stores)[0];
const orders = new JsonStore('orders');

async function ledger(type, data, actor) {
  await fetch(`${MANDATE}/ledger`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, data, actor }),
  }).catch(() => {});
}

const MAX_ATTEMPTS_PER_ORDER = 2;

// A tool handler may return { __http: <status>, ...body } to control the HTTP
// status of a plain /tools call. The MCP transport carries the same body.
const http = (status, body) => ({ __http: status, ...body });

const TOOLS = {
  search_catalog: {
    description: 'Search the merchant catalog. Returns matching products with price and stock.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'free-text search over name, tags, description' },
      max_price_inr: { type: 'number', description: 'only products at or under this price' },
      category: { type: 'string', description: 'e.g. apparel, accessories' },
    }, required: [] },
    handler: (store, { query, max_price_inr, category }) => {
      const q = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
      let list = store.products.filter((p) => p.stock > 0);
      if (category) list = list.filter((p) => p.category === category);
      if (max_price_inr) list = list.filter((p) => p.price_inr <= max_price_inr);
      if (q.length) {
        list = list
          .map((p) => {
            const hay = `${p.name} ${p.tags.join(' ')} ${p.description}`.toLowerCase();
            return { p, score: q.filter((t) => hay.includes(t)).length };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.p);
      }
      return { results: list.map(({ description, ...p }) => p) };
    },
  },
  get_product: {
    description: 'Get full details for one product by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: (store, { id: pid }) => {
      const p = store.products.find((x) => x.id === pid);
      return p ? { product: p } : { error: 'product not found' };
    },
  },
  create_order: {
    description: 'Create an order for one or more products. Returns order_id and total. Does NOT move money. Pass mandate_id to have the order checked against your mandate up front.',
    parameters: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: {
        product_id: { type: 'string' }, qty: { type: 'number' } }, required: ['product_id'] } },
      mandate_id: { type: 'string', description: 'optional: validates merchant and mandate state before the order is created' },
    }, required: ['items'] },
    handler: async (store, { items, mandate_id }) => {
      if (!Array.isArray(items) || items.length === 0) return { error: 'items must be a non-empty array' };

      // If a mandate is named, validate it now rather than letting the agent
      // build an order it can never pay for.
      let mandateNote = null;
      if (mandate_id) {
        const m = await fetch(`${MANDATE}/mandates/${mandate_id}`).then((r) => r.json()).catch(() => null);
        if (!m || m.error) return { error: `mandate ${mandate_id} not found` };
        if (m.merchant !== store.merchant) return { error: `mandate ${mandate_id} is for "${m.merchant}", not "${store.merchant}"` };
        if (m.state !== 'ACTIVE') return { error: `mandate ${mandate_id} is ${m.state}` };
        mandateNote = { mandate_id, remaining_inr: Math.max(0, m.remaining_paise) / 100 };
      }

      let total = 0; const lines = [];
      for (const it of items) {
        const p = store.products.find((x) => x.id === it.product_id);
        if (!p) return { error: `product ${it.product_id} not found` };
        const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
        if (qty > p.stock) return { error: `only ${p.stock} of ${p.name} in stock` };
        total += p.price_inr * qty;
        lines.push({ product_id: p.id, name: p.name, qty, price_inr: p.price_inr, category: p.category });
      }

      const rzpOrder = await rzp.createOrder(total * 100, id('rcpt'), { merchant: store.merchant });
      const order = {
        id: rzpOrder.id, merchant: store.merchant, lines, total_inr: total,
        status: 'created', attempts: 0, payment_mode: rzp.mode,
        razorpay_verified: Boolean(rzpOrder.verified), razorpay_status: rzpOrder.razorpay_status ?? null,
        created_at: new Date().toISOString(),
      };
      orders.put(order.id, order);
      await ledger('ORDER_CREATED', {
        order_id: order.id, merchant: store.merchant, total_inr: total, lines,
        payment_mode: rzp.mode,
        // Proof that this id came back from Razorpay, not just out of our process.
        razorpay_verified: order.razorpay_verified, razorpay_status: order.razorpay_status,
      }, 'storefront');
      return {
        order_id: order.id, total_inr: total, payment_mode: rzp.mode,
        razorpay_verified: order.razorpay_verified,
        categories: [...new Set(lines.map((l) => l.category))],
        ...(mandateNote ? { mandate: mandateNote } : {}),
      };
    },
  },
  pay: {
    description: 'Pay for an order under a mandate. Requires mandate_id; without one the call is refused with HTTP 402 and a mandate challenge. May return escalation_pending (a human must approve); then call pay again with escalation_id. Methods: upi_reserve_pay, test_card_success, test_card_declined.',
    parameters: { type: 'object', properties: {
      order_id: { type: 'string' }, mandate_id: { type: 'string' },
      method: { type: 'string' }, escalation_id: { type: 'string' },
    }, required: ['order_id', 'mandate_id', 'method'] },
    handler: async (store, { order_id, mandate_id, method, escalation_id }) => {
      const order = orders.get(order_id);
      if (!order) return { error: 'order not found' };
      if (order.status === 'paid') return { error: 'order already paid' };

      // x402-shaped challenge: an agent that arrives without authorization is
      // told, in machine-readable terms, exactly what it needs to come back with.
      if (!mandate_id) {
        await ledger('PAYMENT_CHALLENGED', { order_id, reason: 'no mandate presented' }, 'storefront');
        return http(402, {
          type: 'https://agentsetu.dev/problems/mandate-required',
          title: 'Payment mandate required',
          status: 402,
          detail: 'This merchant does not accept agent payments without a human-granted mandate.',
          accepts: [{
            scheme: 'agentsetu-mandate/1',
            description: 'Present mandate_id from a mandate granted by the payer at the mandate engine.',
            amount: { currency: 'INR', value: order.total_inr.toFixed(2) },
            mandate_endpoint: `${MANDATE}/mandates`,
            required_fields: ['mandate_id'],
          }],
        });
      }

      if (order.attempts >= MAX_ATTEMPTS_PER_ORDER) {
        await ledger('PAYMENT_BLOCKED', { order_id, reason: `server-side attempt limit (${MAX_ATTEMPTS_PER_ORDER}) reached for this order` }, 'storefront');
        return { error: `payment blocked: attempt limit (${MAX_ATTEMPTS_PER_ORDER}) reached for this order`, status: 'blocked' };
      }

      const amount_paise = order.total_inr * 100;
      // Every line's category, so nothing rides along inside a multi-item order.
      const categories = [...new Set(order.lines.map((l) => l.category).filter(Boolean))];

      const check = await (await fetch(`${MANDATE}/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mandate_id, merchant: store.merchant, amount_paise, categories, order_id,
          intent: `Pay ₹${order.total_inr} for order ${order_id} (${order.lines.map((l) => l.name).join(', ')})`,
          escalation_id,
        }),
      })).json();

      if (check.decision === 'ESCALATE') return { status: 'escalation_pending', escalation_id: check.escalation_id, reason: check.reason };
      if (check.decision === 'DENY') return { status: 'denied', reason: check.reason };

      order.attempts += 1;
      orders.put(order.id, order);
      await ledger('PAYMENT_ATTEMPT', { order_id, mandate_id, method, amount_inr: order.total_inr, attempt: order.attempts, hold_id: check.hold_id }, 'storefront');

      const result = await rzp.attemptPayment(order, method);

      if (!result.ok) {
        // Give the reserved money back: a decline must not quietly shrink the budget.
        await fetch(`${MANDATE}/release`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hold_id: check.hold_id, reason: `payment failed: ${result.error_reason}` }),
        }).catch(() => {});
        await ledger('PAYMENT_FAILED', { order_id, method, attempt: order.attempts, error: result.error_reason, description: result.description, simulated_capture: result.simulated_capture, hold_released: check.hold_id }, 'storefront');
        return {
          status: 'failed', error: result.error_reason, description: result.description,
          attempts_left: Math.min(MAX_ATTEMPTS_PER_ORDER - order.attempts, check.attempts_left ?? 0),
        };
      }

      order.status = 'paid'; order.payment_id = result.payment_id;
      orders.put(order.id, order);
      await fetch(`${MANDATE}/consume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mandate_id, amount_paise, payment_id: result.payment_id, hold_id: check.hold_id }),
      });
      await ledger('PAYMENT_SUCCEEDED', { order_id, payment_id: result.payment_id, method, amount_inr: order.total_inr, simulated_capture: result.simulated_capture }, 'storefront');
      return { status: 'paid', payment_id: result.payment_id, amount_inr: order.total_inr, simulated_capture: result.simulated_capture };
    },
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
}

function storeFor(slug) {
  return stores[slug || defaultSlug];
}

app.get('/manifest', (req, res) => {
  const store = storeFor(req.query.merchant);
  res.json({
    merchant: store.merchant, slug: store.slug,
    protocol: 'agentsetu-tools/1',
    protocols: {
      http_tools: { version: 'agentsetu-tools/1', endpoint: '/tools/:name' },
      mcp: { shape: 'jsonrpc-2.0 / MCP 2024-11-05', endpoint: '/mcp', methods: ['initialize', 'tools/list', 'tools/call'] },
      payment_challenge: { shape: 'x402-style HTTP 402', trigger: 'pay without mandate_id' },
      mandate: { shape: 'ap2-mandate-shape/preview', endpoint: `${MANDATE}/mandates/:id/ap2` },
    },
    payment_mode: rzp.mode,
    capture: rzp.captureMode,
    capture_note: 'Orders are real Razorpay test-mode orders when keys are configured. The capture leg is simulated deterministically; Razorpay has no server-side charge API and a real capture needs a human at Checkout.',
    tools: toolList(),
  });
});

app.post('/tools/:name', async (req, res) => {
  const store = storeFor(req.body.merchant);
  const tool = TOOLS[req.params.name];
  if (!tool) return res.status(404).json({ error: 'unknown tool' });
  try {
    const out = await tool.handler(store, req.body.args || {});
    if (out && out.__http) {
      const { __http, ...body } = out;
      return res.status(__http).json(body);
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- MCP-shaped JSON-RPC transport ----
// Same tools, spoken the way an MCP client expects, with no extra dependency.
app.post('/mcp', async (req, res) => {
  const { id: rpcId = null, method, params = {} } = req.body || {};
  const ok = (result) => res.json({ jsonrpc: '2.0', id: rpcId, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id: rpcId, error: { code, message } });
  const store = storeFor(params.merchant);

  if (method === 'initialize') {
    return ok({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `agentsetu:${store.slug}`, version: '1.1.0', merchant: store.merchant },
    });
  }
  if (method === 'tools/list') {
    return ok({ tools: toolList().map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS[params.name];
    if (!tool) return fail(-32602, `unknown tool: ${params.name}`);
    try {
      const out = await tool.handler(store, params.arguments || {});
      const { __http, ...body } = out || {};
      return ok({
        content: [{ type: 'text', text: JSON.stringify(body) }],
        isError: Boolean(__http && __http >= 400) || Boolean(body.error),
        ...(__http ? { _meta: { http_status: __http } } : {}),
      });
    } catch (e) {
      return fail(-32603, String(e.message || e));
    }
  }
  return fail(-32601, `method not found: ${method}`);
});

app.get('/orders', (_req, res) => res.json(orders.all()));
app.get('/health', (_req, res) => res.json({ ok: true, merchant: stores[defaultSlug].merchant, payment_mode: rzp.mode }));

const port = process.env.STOREFRONT_PORT || 4100;
app.listen(port, () => console.log(`[storefront] "${stores[defaultSlug].merchant}" agent-ready on :${port} (payments: ${rzp.mode}, capture: ${rzp.captureMode}, MCP at /mcp)`));
