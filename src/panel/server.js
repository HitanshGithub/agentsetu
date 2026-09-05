// Control panel — serves the UI and proxies the mandate engine + storefront
// so the browser talks to one origin.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const MANDATE = `http://localhost:${process.env.MANDATE_PORT || 4001}`;
const STORE = `http://localhost:${process.env.STOREFRONT_PORT || 4100}`;

const app = express();
app.use(express.json());

async function proxy(base, req, res) {
  const url = base + req.url.replace(/^\/api\/(m|s)/, '');
  try {
    const r = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch {
    res.status(502).json({ error: 'upstream unavailable' });
  }
}
// ---- run the buyer agent from the browser ----
// POST /api/agent/run {task, mandate_id?, auto_cap?} -> {run_id}
// GET  /api/agent/run/:id -> {status, log}
const runs = new Map();

app.post('/api/agent/run', (req, res) => {
  const { task, mandate_id, auto_cap } = req.body;
  if (!task || !task.trim()) return res.status(400).json({ error: 'task required' });
  if (!mandate_id && !auto_cap) return res.status(400).json({ error: 'mandate_id or auto_cap required' });

  const id = 'run_' + crypto.randomBytes(4).toString('hex');
  const cliArgs = ['src/agent/run.js', '--json', '--task', task.trim()];
  if (mandate_id) cliArgs.push('--mandate', mandate_id);
  else cliArgs.push('--auto-mandate', String(auto_cap));

  const run = { status: 'running', events: [], log: '', started_at: new Date().toISOString() };
  runs.set(id, run);

  const child = spawn(process.execPath, cliArgs, { cwd: process.cwd() });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete tail for the next chunk
    for (const line of lines) {
      if (!line.trim()) continue;
      try { run.events.push(JSON.parse(line)); }
      catch { run.log = (run.log + line + '\n').slice(-8000); }
    }
  });
  const append = (d) => { run.log = (run.log + d.toString()).slice(-8000); };
  child.stderr.on('data', append);
  child.on('close', (code) => { run.status = code === 0 ? 'done' : 'error'; });
  child.on('error', (e) => { run.status = 'error'; append(`\nspawn failed: ${e.message}`); });

  // safety: kill a stuck run after 5 minutes
  setTimeout(() => { if (run.status === 'running') { child.kill(); run.status = 'error'; append('\n(timed out after 5 minutes)'); } }, 300000).unref();

  res.json({ run_id: id });
});

app.get('/api/agent/run/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

app.use('/api/m', (req, res) => proxy(MANDATE, req, res));
app.use('/api/s', (req, res) => proxy(STORE, req, res));

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
app.use(express.static(pub));

const port = process.env.PANEL_PORT || 3000;
app.listen(port, () => console.log(`[panel] control panel on http://localhost:${port}`));
