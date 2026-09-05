# What broke, what I chose, and what I would not ship

This is the honest half of the submission. The README says what AgentSetu does.
This says where it bent, what I got wrong the first time, and which claims I had
to walk back once I attacked my own code.

Everything below is reproducible: `npm test` runs the attacks as a suite.

---

## The four holes I found in my own gate

I wrote the mandate engine, then spent an evening trying to rob it. Four of the
attacks worked. All four are now closed and each one has a test that fails if I
undo the fix. I checked that: I reverted each fix in a scratch copy and watched
the matching test go red.

### 1. An off-category item could ride along in a multi-item order

The category check read `order.lines[0].category`. A mandate scoped to `apparel`
happily paid for `[hoodie, cap]` because the hoodie was first in the array. The
gate was reading one item and vouching for the basket.

Fixed by checking every line's category. The escalation reason now names the
offending categories, so the human sees exactly what tripped it.

### 2. The agent could buy itself unlimited retries

The retry limit was `MAX_ATTEMPTS_PER_ORDER = 2`, enforced by the storefront.
But nothing stopped the agent calling `create_order` again for the same product
and getting two fresh attempts, forever. The cap still held the line on money, so
this was not a way to overspend, but "the server caps retries" was not true as
written. Against a payment rail with per-attempt costs or fraud scoring, an
unbounded retry loop is its own incident.

Fixed by moving the attempt budget onto the mandate: every ALLOW spends one
attempt, across every order, and a mandate with no attempts left is a hard deny.
The per-order limit stayed as a second, narrower fence.

### 3. Two concurrent payments could both spend the same headroom

Classic time-of-check to time-of-use. `check` compared the amount against
`cap - spent`, and `spent` only moved after a payment settled. Two payments
launched together both passed the check, both settled, and the mandate ended up
overspent. In the test that reproduces this, a ₹2000 mandate paid out ₹2998.

Fixed with holds. An ALLOW reserves the amount (`held_paise`) before the payment
is attempted; settlement converts held to spent, failure releases it, and a hold
that never reports back expires after five minutes so a crashed storefront cannot
freeze a mandate forever. Headroom is now `cap - spent - held`.

### 4. A decline quietly ate budget

Once holds existed, the first version leaked them: a failed payment left the
money reserved. The storefront now releases the hold on every failure path, and
a test asserts the full headroom is spendable again after a decline.

Two more, smaller: an approved escalation had no expiry (it is now good for 15
minutes and for that exact amount and order), and `amount_paise` was never
validated as positive.

---

## What I decided not to fake

### The capture leg is simulated, and it is labeled everywhere

Orders are real. With Razorpay test keys set, `create_order` hits the live
test-mode Orders API and then fetches the order back, so the ledger records
Razorpay's view of it, not mine. You can match ledger order ids against the
dashboard.

The capture is simulated, for two reasons. Razorpay has no server-side "charge
this order" call, so a real capture needs a human at Checkout with a test card,
which is exactly the thing an autonomous agent cannot drive. And a simulated
capture is deterministic, so the failure demo reproduces on any machine with no
keys at all.

I could have hidden this behind a Checkout page and clicked it myself on camera.
I would rather say it out loud: `capture: "simulated"` is in the manifest, on
every payment ledger event, and in the panel. What the demo proves is the
authorization path, which is the part I claim is novel. It does not prove I can
move real money, because I cannot, without a human at a checkout page.

### The ledger is signed, not notarized

The first version was a plain SHA-256 chain. That detects an accidental edit and
nothing else: anyone who can write the file can recompute every hash after the
one they changed, and the chain verifies clean. I had described that as
"tamper-evident", which was an overclaim.

Now every event is HMAC-signed with a key that does not live in the ledger file
(`LEDGER_SECRET`, or a generated `runtime/.ledger-key`), and the head hash and
event count are anchored in a separate file. That closes two real attacks: a
re-chained forgery fails because the attacker cannot sign it, and a truncation
fails because the anchor knows how many events there should be. Both have tests.

What it still does not survive: an attacker who owns the machine and reads the
key, or the writer process itself lying at write time. Honest fix is an
asymmetric key held off-box, or anchoring the head hash to something the writer
cannot reach. That is a real design, not a weekend.

### The gate is a separate process, not a separate trust domain

The mandate engine runs on its own port so the LLM has no in-process path to the
rules. That is genuinely load-bearing against a prompt-injected agent. It is not
a security boundary against someone with a shell on the box: there is no
authentication between the storefront and the engine. In production the engine
is a service with mTLS and the storefront holds a scoped credential. For a
demo on one laptop, the process boundary is the honest claim.

---

## Choices a judge might push on

**Why transactability and not growth?** Track 01 asks for revenue growth or
agent transactability. I took the second. Growth agents (upsell, campaigns) are
recommendation problems with a payment attached, and the interesting risk is in
the payment. If an AI buyer can transact with ten million merchants, the growth
tools are downstream of that, and none of it ships until the money is safe.

**Why not a hosted MCP server with the official SDK?** The tool surface is the
same code behind three transports: plain HTTP, an MCP-shaped JSON-RPC endpoint
at `/mcp` (`initialize`, `tools/list`, `tools/call`), and an x402-style HTTP 402
challenge when an agent tries to pay with no mandate. I wrote the JSON-RPC shape
by hand rather than pulling the SDK so the whole thing stays a `npm install` with
three dependencies and no build step. The mandate also renders in an AP2-shaped,
signed view at `/mandates/:id/ap2`. The shapes are right; conformance testing
against a real AP2 verifier is not done.

**Why a file-backed store?** Because Postgres would have cost me the evening I
spent attacking the gate, and the gate is the point. `JsonStore` writes through a
temp file and renames, so a crash cannot leave half a JSON document. The ledger
is append-only NDJSON with a single writer, which is the property that actually
matters. It is not a database and I would not run a payment system on it.

---

## What I would do next, in order

1. Asymmetric ledger signatures with the key off the machine, and periodic head
   anchoring to an external store. This is the difference between "you can see
   the tamper" and "you cannot tamper".
2. Authentication between the storefront and the mandate engine, so the gate is
   a trust boundary and not just a process boundary.
3. Idempotency keys on `pay`, so a retried network call cannot become a second
   payment. Today the order status guards this; a key is the correct fix.
4. Real capture through Checkout with a human in the loop for the first payment
   of a mandate, then agent-driven capture inside the mandate afterwards. That
   is closer to how Reserve Pay actually behaves.
5. A merchant-side view. Right now the panel is the payer's. The merchant has
   no way to see which of their sales came from an agent, which is exactly the
   thing they will want to know first.
