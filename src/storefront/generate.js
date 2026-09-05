// Onboarding engine: CSV catalog in -> agent-ready merchant storefront out.
//   npm run generate -- data/sample-catalog.csv "Arjun Apparel"
// Produces merchants/<slug>.json which the storefront server exposes as MCP-style tools.
import fs from 'node:fs';
import path from 'node:path';

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',');
  return rows.map((row) => {
    // naive CSV split is fine here: our fields contain no commas; real build would use papaparse
    const vals = row.split(',');
    const obj = {};
    cols.forEach((c, i) => (obj[c] = vals[i] ?? ''));
    obj.price_inr = Number(obj.price_inr);
    obj.stock = Number(obj.stock);
    obj.tags = (obj.tags || '').split('|').filter(Boolean);
    return obj;
  });
}

const [file, merchantName] = process.argv.slice(2);
if (!file || !merchantName) {
  console.error('usage: npm run generate -- <catalog.csv> "<Merchant Name>"');
  process.exit(1);
}
const slug = merchantName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const products = parseCsv(fs.readFileSync(file, 'utf8'));
const store = {
  merchant: merchantName,
  slug,
  currency: 'INR',
  generated_at: new Date().toISOString(),
  products,
};
const out = path.resolve('merchants', `${slug}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(store, null, 2));
console.log(`✔ ${merchantName}: ${products.length} products -> ${out}`);
console.log(`  This merchant is now agent-readable. Start it with: npm run storefront`);
