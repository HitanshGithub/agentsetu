// Razorpay test-mode client.
//
// Orders are REAL. With RAZORPAY_KEY_ID/SECRET set, create_order calls the live
// test-mode Orders API and then FETCHES THE ORDER BACK, so what the ledger
// records is Razorpay's own view of the order, not ours. Those orders appear in
// your Razorpay test dashboard and can be checked against the ledger by id.
//
// The capture leg is SIMULATED, deliberately and visibly:
//   - Razorpay has no server-side "charge this order" API; a real capture needs
//     a human at Checkout with a test card, which an autonomous agent cannot drive.
//   - A simulated capture is deterministic, so the failure demo is reproducible
//     on any machine with no keys at all.
// Every simulated result is flagged simulated_capture: true and surfaces in the
// manifest, the ledger and the panel. Nothing here pretends to be a real capture.
//
//   method "test_card_declined"  -> always fails (issuer_declined)
//   method "test_card_success"   -> always succeeds
//   method "upi_reserve_pay"     -> always succeeds
import crypto from 'node:crypto';

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
export const mode = KEY_ID ? 'razorpay-test-api' : 'local-simulator';
export const captureMode = 'simulated';

function auth() {
  return 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
}

export async function createOrder(amount_paise, receipt, notes) {
  if (!KEY_ID) {
    return {
      id: 'order_sim_' + crypto.randomBytes(5).toString('hex'),
      amount_paise, mode, verified: false,
      verification_note: 'no Razorpay keys configured, order id generated locally',
    };
  }

  const resp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amount_paise, currency: 'INR', receipt, notes }),
  });
  if (!resp.ok) throw new Error(`Razorpay order failed: ${resp.status} ${await resp.text()}`);
  const o = await resp.json();

  // Read it back from Razorpay so the ledger records their state, not our hope.
  const check = await fetchOrder(o.id);
  return {
    id: o.id,
    amount_paise: o.amount,
    mode,
    verified: Boolean(check && check.id === o.id),
    razorpay_status: check?.status ?? o.status,
    receipt: o.receipt,
    created_at_rzp: o.created_at,
  };
}

export async function fetchOrder(orderId) {
  if (!KEY_ID) return null;
  try {
    const r = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, { headers: { Authorization: auth() } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function attemptPayment(order, method) {
  await new Promise((r) => setTimeout(r, 300)); // simulate network
  if (method === 'test_card_declined') {
    return {
      ok: false, simulated_capture: true,
      error_code: 'BAD_REQUEST_ERROR', error_reason: 'issuer_declined',
      description: 'The card issuer declined the transaction.',
    };
  }
  return {
    ok: true, simulated_capture: true,
    payment_id: 'pay_sim_' + crypto.randomBytes(5).toString('hex'),
    method,
  };
}
