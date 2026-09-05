// Start all three services with one command: npm run dev
import { spawn } from 'node:child_process';
const procs = [
  ['mandate-engine', 'src/mandate/server.js'],
  ['storefront', 'src/storefront/server.js'],
  ['panel', 'src/panel/server.js'],
];
const children = [];
for (const [name, file] of procs) {
  const p = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(p);
}
console.log('AgentSetu: mandate-engine :4001 · storefront :4100 · panel http://localhost:3000');
setInterval(() => {}, 1 << 30); // keep parent alive
process.on('SIGINT', () => { children.forEach((c) => c.kill()); process.exit(0); });
