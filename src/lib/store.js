// Tiny file-backed persistence: JSON docs for state, append-only NDJSON for the ledger.
//
// The ledger is a SIGNED hash chain. Every event carries an HMAC-SHA256 over
// (seq, ts, type, actor, canonical(data), prev_hash) keyed by a secret that does
// not live in the ledger file. That is the difference between "you can see the
// edit" and "you cannot forge a replacement": a plain SHA-256 chain can be fully
// recomputed by anyone who can write the file, so it only catches accidents.
//
// The chain alone also cannot see a TRUNCATION (delete the last N lines and the
// remaining prefix still verifies), so the head hash and event count are anchored
// in a separate file after every append and checked on verify.
//
// Single-writer by design: only the mandate engine appends. The storefront and
// the agent POST to its /ledger endpoint. That keeps appends serialized in one
// process, so the in-memory tail cache below is safe and appends are O(1)
// instead of re-reading the whole file each time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RUNTIME = path.resolve(process.env.RUNTIME_DIR || path.join(process.cwd(), 'runtime'));
fs.mkdirSync(RUNTIME, { recursive: true });

const LEDGER_FILE = path.join(RUNTIME, 'ledger.ndjson');
const ANCHOR_FILE = path.join(RUNTIME, 'anchor', 'ledger.head.json');
const KEY_FILE = path.join(RUNTIME, '.ledger-key');
fs.mkdirSync(path.dirname(ANCHOR_FILE), { recursive: true });

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export class JsonStore {
  constructor(name) {
    this.file = path.join(RUNTIME, `${name}.json`);
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : {};
  }
  get(key) { return this.data[key]; }
  all() { return Object.values(this.data); }
  put(key, value) {
    this.data[key] = value;
    // write-then-rename so a crash mid-write cannot leave a truncated JSON file
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return value;
  }
}

// ---- signing key ----------------------------------------------------------
// Prefer LEDGER_SECRET from the environment (in production this would be a KMS
// key or an HSM, held outside the machine that writes the ledger). Fall back to
// a generated key file so the demo works with zero setup; runtime/ is gitignored.
function loadKey() {
  if (process.env.LEDGER_SECRET) return process.env.LEDGER_SECRET;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
  return k;
}
const SECRET = loadKey();
export const ledgerKeySource = process.env.LEDGER_SECRET ? 'env:LEDGER_SECRET' : 'generated-file';

// Key order must not change the signature, so serialize deterministically.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function eventMac(seq, ts, type, actor, data, prevHash) {
  return crypto.createHmac('sha256', SECRET)
    .update(`${seq}|${ts}|${type}|${actor}|${canonical(data)}|${prevHash}`)
    .digest('hex');
}

export function signPayload(obj) {
  return crypto.createHmac('sha256', SECRET).update(canonical(obj)).digest('hex');
}

// ---- ledger ---------------------------------------------------------------
export function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs.readFileSync(LEDGER_FILE, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let tail = null;      // last event written, cached so append is O(1)
let tailLoaded = false;

function loadTail() {
  if (tailLoaded) return;
  const events = readLedger();
  tail = events[events.length - 1] ?? null;
  tailLoaded = true;
}

function writeAnchor(event, count) {
  const anchor = { head_hash: event?.hash ?? 'GENESIS', count, updated_at: new Date().toISOString() };
  anchor.anchor_mac = crypto.createHmac('sha256', SECRET)
    .update(`${anchor.head_hash}|${anchor.count}`).digest('hex');
  const tmp = `${ANCHOR_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(anchor, null, 2));
  fs.renameSync(tmp, ANCHOR_FILE);
}

export function appendLedger(type, data, actor) {
  loadTail();
  const seq = (tail?.seq ?? 0) + 1;
  const ts = new Date().toISOString();
  const prevHash = tail?.hash ?? 'GENESIS';
  const act = actor ?? 'system';
  const event = { seq, ts, type, actor: act, data, prev_hash: prevHash };
  event.hash = eventMac(seq, ts, type, act, data, prevHash);
  // O_APPEND: a single small write is atomic, so a concurrent reader never sees
  // half a line even while the file is being written.
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(event) + '\n');
  tail = event;
  writeAnchor(event, seq);
  return event;
}

function readAnchor() {
  if (!fs.existsSync(ANCHOR_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(ANCHOR_FILE, 'utf8')); } catch { return null; }
}

export function verifyLedger() {
  const events = readLedger();
  let prevHash = 'GENESIS';
  for (const e of events) {
    if (e.prev_hash !== prevHash) {
      return { intact: false, broken_at: e.seq, count: events.length, reason: 'chain link mismatch', signed: true };
    }
    const mac = eventMac(e.seq, e.ts, e.type, e.actor, e.data, e.prev_hash);
    const ok = typeof e.hash === 'string' && e.hash.length === mac.length &&
      crypto.timingSafeEqual(Buffer.from(e.hash, 'hex'), Buffer.from(mac, 'hex'));
    if (!ok) {
      return { intact: false, broken_at: e.seq, count: events.length, reason: 'signature does not verify', signed: true };
    }
    prevHash = e.hash;
  }

  // Truncation check: the chain above is happy with any prefix of itself.
  const anchor = readAnchor();
  if (anchor) {
    const expectedMac = crypto.createHmac('sha256', SECRET)
      .update(`${anchor.head_hash}|${anchor.count}`).digest('hex');
    if (anchor.anchor_mac !== expectedMac) {
      return { intact: false, broken_at: events.length, count: events.length, reason: 'anchor signature does not verify', signed: true };
    }
    if (anchor.count > events.length) {
      return {
        intact: false, broken_at: events.length + 1, count: events.length,
        reason: `truncated: anchor expects ${anchor.count} events, file has ${events.length}`, signed: true,
      };
    }
    if (anchor.count === events.length && anchor.head_hash !== (events[events.length - 1]?.hash ?? 'GENESIS')) {
      return { intact: false, broken_at: events.length, count: events.length, reason: 'head hash does not match anchor', signed: true };
    }
  }

  return { intact: true, count: events.length, signed: true, anchored: Boolean(anchor), key_source: ledgerKeySource };
}
