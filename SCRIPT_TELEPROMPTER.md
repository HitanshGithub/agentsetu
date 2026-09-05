# AgentSetu — teleprompter cut

Words only. ~715 spoken words, ~5:00 at a natural pace. Read the **SAY** lines.
Everything else is a screen cue. Prep checklist and fallbacks are in VIDEO_SCRIPT.md.

Pace note: you have room. Do not rush the attack scene, it is the one that
separates you from every other submission. If you run long, cut scene 1 to one
sentence over a still.

---

### 0:00 — Hook
**SCREEN:** panel, empty and clean (or the workflow diagram).

**SAY:**
In February, Razorpay and NPCI made it possible to order from Zomato, Swiggy and
Zepto inside an AI chat. Those three integrations were hand-built. India has ten
million other merchants, and no way for an AI to buy from them safely. I built
AgentSetu: the bridge that makes any merchant sellable to AI buyers, in five
minutes, with spending limits the AI cannot break.

---

### 0:22 — Onboarding
**SCREEN:** terminal. Run `npm run generate -- data/sample-catalog.csv "Arjun Apparel"`

**SAY:**
Here's a merchant that exists only as a CSV, the kind of catalog export any small
store already has. One command, and Arjun Apparel is agent-readable. Search,
product, order and pay, exposed as tools over plain HTTP and over MCP, with a
402 payment challenge if an agent turns up with no authorization. That is the
entire onboarding.

---

### 0:48 — Consent, then an autonomous purchase
**SCREEN:** panel. Grant a mandate: cap 1500, uses 2, expiry 60. Point at the card.

**SAY:**
Before any AI touches money, a human grants a mandate. This mirrors UPI Reserve
Pay, the consent pattern Razorpay and NPCI shipped. A cap, a category, a use
count, an attempt budget, an expiry, and instant revocation.

**SCREEN:** Run agent: "buy me a black hoodie under 1500 rupees". Let the timeline fill.

**SAY:**
Now I ask the agent to buy a black hoodie under fifteen hundred rupees. Watch the
timeline. It searches the catalog, compares options, and before paying it has to
declare its intent on the audit ledger. What it is buying, for how much, and why.
Then it pays, and the mandate meter fills. That purchase was autonomous, but every
rupee moved inside rules a human set.

---

### 1:55 — The human gate
**SCREEN:** Run agent again: "buy me the premium zip hoodie", same mandate.
Escalation card appears. Read it on screen, then click Approve.

**SAY:**
Now the premium hoodie. Twenty-seven hundred rupees, way over what is left. The
agent does not fail, and it does not sneak through. It is blocked by the mandate
engine, a separate service the model cannot reach, and it escalates to me. Here
is the card: the amount, why it was blocked, and the agent's own reasoning. I
approve, and that approval is good for this exact amount, on this order, once,
and it expires in fifteen minutes. And this revoke button kills a mandate
instantly, mid-session.

---

### 2:45 — Failure, handled
**SCREEN:** fresh mandate. Run agent with the declining test card. Red card, then green.

**SAY:**
Payments fail, so let's force one. The issuer declines, and two things happen.
The money reserved for that payment goes straight back onto the mandate, so a
decline never quietly eats your budget. And the agent does not loop. Its policy
allows one retry with a different method, and the attempt budget is enforced by
the engine, not by the model. One bounded retry over UPI, and it recovers.

---

### 3:25 — Attacking my own gate
**SCREEN:** terminal, `npm run demo:scripted -- attack`. Then flick to the ledger column.

**SAY:**
Here is the part I actually care about. I wrote this gate, then I spent an
evening trying to rob it, and four attacks worked.

One: pay with no mandate at all. You get a 402 telling you exactly what
authorization you are missing.

Two: hide an off-category item inside a multi-item order. My first version
checked only the first line, so a cap could ride along on a hoodie.

Three: buy yourself more retries by opening a fresh order each time. My retry
limit was per order, so this worked forever.

Four: two payments at the same instant, both passing the cap check before either
one settles. A two thousand rupee mandate paid out two thousand nine hundred and
ninety-eight.

All four are closed. Every one has a test that goes red if I undo the fix, and
the suite is seventeen attacks, no keys, no network.

---

### 4:25 — The audit trail
**SCREEN:** scroll the ledger slowly. Hover a hash. Point at the green badge.

**SAY:**
This is the flight recorder. Every mandate, intent, check, hold, payment, failure
and human decision. I first called it tamper-evident, and that was an overclaim,
because a plain hash chain can be recomputed by anyone who can write the file. So
every event is now signed with a key that is not in the file, and the head is
anchored separately. A forged event and a deleted tail both show up as tampered.
One more honest note: the capture leg here is simulated, because Razorpay has no
server-side charge API. The orders are real, and the label says simulated
everywhere it matters.

---

### 4:50 — Close
**SCREEN:** architecture diagram.

**SAY:**
The rule underneath all of it: the LLM decides what to buy, deterministic code
decides whether money moves. Razorpay's pilot proved agentic commerce works for
the giants. AgentSetu is the on-ramp for everyone else. Track one. Thank you.
