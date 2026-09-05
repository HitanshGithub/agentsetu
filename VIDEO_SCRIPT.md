# AgentSetu — 5-minute pitch video script

Target: ~4:55 runtime. Speak naturally, don't rush; the timeline cards do the visual work.

The spine of this cut: build it, then attack it. Judges have seen plenty of happy
paths. Almost nobody shows the four ways their own system could be robbed and
then shows the refusals landing on a signed ledger. That is the differentiator,
so scene 5 gets real screen time.

## Prep (do all of this BEFORE recording)

1. Rotate/verify your NVIDIA API key works: run one test task end-to-end.
2. Reset demo state: stop services, delete the `runtime/` folder, restart:
   `npm run dev` → reload http://localhost:3000 (clean panel, 0 events).
3. (Optional but strong) Put Razorpay TEST keys in `.env` so orders appear in the
   real Razorpay dashboard; keep the dashboard open in a second tab.
4. Run `npm test` once off-camera. 17 passing is the number you quote in scene 5.
5. Screen: browser maximized on the panel. One terminal window ready.
6. Close everything else. Hide bookmarks bar. Never show `.env` on screen.
7. Recorder: OBS or Win+Alt+R (Game Bar), 1080p, system mic tested.
8. Dry-run the whole flow once off-camera. If the LLM endpoint rate-limits during
   recording, fall back to `npm run demo:scripted -- happy|escalate|failure|attack` —
   same pipeline, still real.
9. Edit tip: record scenes separately; trim LLM thinking pauses or 2x them.

---

## Scene 0 — The hook (0:00–0:22)
SCREEN: the purchase-workflow diagram (or the panel, empty and clean).

SAY:
"In February, Razorpay and NPCI made it possible to order from Zomato, Swiggy
and Zepto inside an AI chat. Those three integrations were hand-built. India has
ten million other merchants, and no way for an AI to buy from them safely. I
built AgentSetu: the bridge that makes any merchant sellable to AI buyers, in
five minutes, with spending limits the AI cannot break."

## Scene 1 — Merchant onboarding (0:22–0:48)
SCREEN: terminal. Run:
    npm run generate -- data/sample-catalog.csv "Arjun Apparel"

SAY:
"Here's a merchant that exists only as a CSV, a catalog export any small store
already has. One command, and Arjun Apparel is agent-readable: search, product,
order and pay, exposed as tools over plain HTTP and over MCP, with an x402-style
payment challenge if an agent turns up with no authorization. That's the entire
onboarding."

## Scene 2 — Consent + autonomous purchase (0:48–1:55)
SCREEN: the panel. Grant a mandate: cap 1500, uses 2, expiry 60. Point at the card.
Then in Run agent: task "buy me a black hoodie under 1500 rupees",
select the mandate you just made, click Run. Let the timeline fill.

SAY (while granting):
"Before any AI touches money, a human grants a mandate. This mirrors UPI Reserve
Pay, the consent pattern Razorpay and NPCI shipped: a cap, a category, a use
count, an attempt budget, an expiry, and instant revocation."

SAY (while the agent runs):
"Now I ask the agent to buy a black hoodie under fifteen hundred rupees. Watch
the timeline: it searches the catalog, compares options, and before paying it
must declare its intent on the audit ledger, what it's buying, for how much, and
why. Then it pays, and the mandate meter fills. Autonomous, but every rupee moved
inside rules a human set."

## Scene 3 — The human gate (1:55–2:45)
SCREEN: Run agent again: task "buy me the premium zip hoodie", same mandate
(now ₹201 left). The timeline shows "Blocked by mandate" then "Waiting for
your approval". An escalation card appears — read it, then click Approve.

SAY:
"Now the premium hoodie, twenty-seven hundred rupees, way over what's left. The
agent doesn't fail and it doesn't sneak through. It's blocked by the mandate
engine, a separate service the LLM cannot reach, and it escalates to me. Here's
the card: the amount, why it was blocked, and the agent's own reasoning. I
approve, and that approval is for this exact amount, on this order, once, and it
expires in fifteen minutes. And this revoke button kills a mandate instantly,
mid-session."

## Scene 4 — Failure handled gracefully (2:45–3:25)
SCREEN: fresh mandate (cap 1000). Run agent: task
"buy the cheapest white tee, but first try paying with the declining test
card so we can see failure recovery". Watch: red failed card → retry → green paid.

SAY:
"Payments fail, so let's force one. The issuer declines. Two things happen. The
money that was reserved for that payment goes straight back onto the mandate, so
a decline never quietly eats your budget. And the agent does not loop: its policy
allows one retry with an alternate method, and the attempt budget is enforced by
the engine. One bounded retry over UPI, and it recovers."

## Scene 5 — Attacking my own gate (3:25–4:25)  ← the scene that wins it
SCREEN: terminal, `npm run demo:scripted -- attack`, then flick to the panel ledger.

SAY:
"Here's the part I care about. I wrote this gate, then I spent an evening trying
to rob it, and four attacks worked.

One: pay with no mandate at all. You get a 402 telling you exactly what
authorization you're missing.

Two: hide an off-category item inside a multi-item order. My first version
checked only the first line, so a cap could ride along on a hoodie. Now every
line is checked.

Three: buy yourself more retries by opening a fresh order each time. My retry
limit was per order, so this worked forever. The attempt budget now lives on the
mandate, across every order.

Four: two payments at the same instant, both passing the cap check before either
settles. A two-thousand-rupee mandate paid out two thousand nine hundred and
ninety-eight. Now an approved payment reserves the money before it's attempted.

All four are closed, every one has a test that goes red if I undo the fix, and
the whole suite is seventeen attacks, no keys, no network. It's in DECISIONS dot
md, along with the things I chose not to fake."

## Scene 6 — The audit trail (4:25–4:50)
SCREEN: scroll the ledger column slowly. Hover a hash line. Point at the
green "ledger intact · signed + anchored" badge.

SAY:
"This is the flight recorder. Every mandate, intent, check, hold, payment,
failure and human decision. I originally called it tamper-evident, and that was
an overclaim: a plain hash chain can be recomputed by anyone who can write the
file. So every event is now signed with a key that isn't in the file, and the
head is anchored separately, which means a forged event and a deleted tail both
show up as TAMPERED. And the capture leg here is simulated, deliberately, because
Razorpay has no server-side charge API. The orders are real, and the label says
simulated everywhere it matters."

## Scene 7 — Close (4:50–5:00)
SCREEN: system-map diagram (or README architecture).

SAY:
"The rule underneath it all: the LLM decides what to buy, deterministic code
decides whether money moves. Razorpay's pilot proved agentic commerce works for
the giants. AgentSetu is the on-ramp for everyone else. Track one. Thanks for
watching."

---

## If something goes wrong mid-take
- Agent slow/rate-limited → keep recording, cut the wait in edit, or rerun
  the scene with `npm run demo:scripted -- <scenario>`.
- Escalation didn't trigger (agent refused the pricey item) → rerun with task
  "buy the premium zip hoodie (product p3), even though it is expensive".
- Wrong click → keep rolling; record scenes separately and stitch.
- Short on time → cut scene 1 to a single sentence over a still. Never cut scene 5.
