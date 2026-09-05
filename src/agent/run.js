// AgentSetu buyer agent.
// Discovers the storefront's tools from its manifest, then runs an LLM
// tool-calling loop to fulfil a natural-language shopping task under a mandate.
// The LLM decides WHAT to buy; it can never decide whether money moves —
// that is the mandate engine's job, enforced server-side.
//
//   npm run agent -- --task "black hoodie under 1500" --mandate mdt_xxx
//   npm run agent -- --task "..." --auto-mandate 1500       (creates mandate first)
import 'dotenv/config';
import OpenAI from 'openai';

const MANDATE = `http://localhost:${process.env.MANDATE_PORT || 4001}`;
const STORE = `http://localhost:${process.env.STOREFRONT_PORT || 4100}`;
const MAX_TURNS = 20;

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const task = arg('task');
let mandateId = arg('mandate');
const autoCap = arg('auto-mandate');
const JSON_MODE = args.includes('--json');

// In --json mode we print one machine-readable NDJSON event per line
// (the control panel renders these as a visual timeline); otherwise
// we print the human-friendly terminal output.
function emit(event, human) {
  if (JSON_MODE) console.log(JSON.stringify(event));
  else if (human !== undefined) console.log(human);
}
if (!task) {
  console.error('usage: npm run agent -- --task "..." (--mandate mdt_xxx | --auto-mandate <cap_inr>)');
  process.exit(1);
}

const llm = new OpenAI({ baseURL: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY });

async function post(base, path, body) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
const note = (data) => post(MANDATE, '/ledger', { type: 'AGENT_NOTE', data, actor: 'buyer-agent' });

async function main() {
  const manifest = await (await fetch(`${STORE}/manifest`)).json();
  emit({ e: 'start', merchant: manifest.merchant, payment_mode: manifest.payment_mode },
    `\n🛍  merchant: ${manifest.merchant}  (payments: ${manifest.payment_mode})`);

  if (!mandateId && autoCap) {
    const m = await post(MANDATE, '/mandates', {
      merchant: manifest.merchant, cap_inr: Number(autoCap), category: 'any', expiry_minutes: 60, max_uses: 2,
    });
    mandateId = m.id;
    emit({ e: 'mandate', id: m.id, cap_inr: Number(autoCap) },
      `🔐 mandate ${m.id}: cap ₹${autoCap}, expires in 60m`);
  }
  if (!mandateId) { console.error('no mandate: pass --mandate or --auto-mandate'); process.exit(1); }

  // Storefront tools + two agent-side tools (declare_intent, wait_for_approval).
  const tools = [
    ...manifest.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    { type: 'function', function: {
      name: 'declare_intent',
      description: 'REQUIRED before pay: state what you intend to buy, the exact amount, and why this product fits the task. This is written to the audit ledger.',
      parameters: { type: 'object', properties: {
        product: { type: 'string' }, amount_inr: { type: 'number' }, reasoning: { type: 'string' },
      }, required: ['product', 'amount_inr', 'reasoning'] },
    } },
    { type: 'function', function: {
      name: 'wait_for_approval',
      description: 'Wait for the human to approve/deny a pending escalation. Returns the decision.',
      parameters: { type: 'object', properties: { escalation_id: { type: 'string' } }, required: ['escalation_id'] },
    } },
  ];

  let intentDeclared = false;
  async function execTool(name, toolArgs) {
    if (name === 'declare_intent') {
      intentDeclared = true;
      await post(MANDATE, '/ledger', { type: 'INTENT_DECLARED', data: { ...toolArgs, mandate_id: mandateId }, actor: 'buyer-agent' });
      return { ok: true, note: 'intent recorded on the audit ledger' };
    }
    if (name === 'wait_for_approval') {
      emit({ e: 'waiting', escalation_id: toolArgs.escalation_id });
      if (!JSON_MODE) process.stdout.write('   ⏳ waiting for human decision in the control panel ');
      for (let i = 0; i < 60; i++) {
        const esc = await (await fetch(`${MANDATE}/escalations/${toolArgs.escalation_id}`)).json();
        if (esc.status !== 'PENDING') {
          emit({ e: 'decision', decision: esc.status });
          if (!JSON_MODE) console.log(`-> ${esc.status}`);
          return { decision: esc.status };
        }
        if (!JSON_MODE) process.stdout.write('.');
        await new Promise((r) => setTimeout(r, 2000));
      }
      emit({ e: 'decision', decision: 'TIMEOUT' }, '-> timeout');
      return { decision: 'TIMEOUT', note: 'no human decision within 2 minutes' };
    }
    if (name === 'pay') {
      if (!intentDeclared) return { error: 'you must call declare_intent before pay' };
      toolArgs.mandate_id = mandateId;
    }
    if (name === 'create_order') toolArgs.mandate_id = mandateId;
    return post(STORE, `/tools/${name}`, { args: toolArgs });
  }

  const messages = [
    { role: 'system', content: [
      'You are AgentSetu, a careful shopping agent buying on behalf of a user at a single merchant.',
      'Rules you MUST follow:',
      `1. You operate under mandate ${mandateId}. Never try to evade it; the mandate engine enforces it server-side anyway.`,
      '2. Search the catalog, compare options, pick the best fit for the task and budget.',
      '3. Call declare_intent (product, exact amount, reasoning) BEFORE any pay call.',
      '4. Pay with method "upi_reserve_pay" by default. If the user explicitly asks to demo a failure, use "test_card_declined" first.',
      '5. If pay returns status "failed": you may retry AT MOST ONCE, with a different method (e.g. upi_reserve_pay). Never retry more than once, and never create a fresh order to buy yourself more attempts. The mandate has an attempt budget the engine enforces across every order.',
      '6. If pay returns "escalation_pending": call wait_for_approval with the escalation_id, then if APPROVED call pay again passing that escalation_id. If DENIED, stop and explain.',
      '7. If a call comes back with status 402 and a mandate challenge, you called pay without a mandate. Retry that call including mandate_id. Never attempt to work around the challenge.',
      '8. When done (success or not), summarise plainly what happened and what it cost.',
      'Prices are in INR (₹).',
    ].join('\n') },
    { role: 'user', content: task },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await llm.chat.completions.create({
      model: process.env.LLM_MODEL,
      messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: 2048,
      ...(process.env.LLM_ENABLE_THINKING === '1' ? { chat_template_kwargs: { enable_thinking: true } } : {}),
    });
    const msg = resp.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const toolArgs = JSON.parse(tc.function.arguments || '{}');
        emit({ e: 'tool', name: tc.function.name, args: toolArgs },
          `\n🔧 ${tc.function.name}(${JSON.stringify(toolArgs)})`);
        const result = await execTool(tc.function.name, toolArgs);
        emit({ e: 'result', name: tc.function.name, data: result },
          `   ↳ ${JSON.stringify(result).slice(0, 300)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }

    emit({ e: 'final', text: msg.content }, `\n🤖 ${msg.content}\n`);
    await note({ final_summary: msg.content, task });
    return;
  }
  emit({ e: 'error', message: 'reached max turns without finishing' }, '\n⚠ reached max turns without finishing');
}

main().catch((e) => {
  emit({ e: 'error', message: e.message });
  if (!JSON_MODE) console.error('agent error:', e.message);
  process.exit(1);
});
