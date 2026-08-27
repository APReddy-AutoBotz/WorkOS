import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
const required = [
  'docs/00-control/PRODUCT_REQUIREMENTS.md',
  'docs/04-quality/NON_FUNCTIONAL_REQUIREMENTS.md',
  'docs/02-architecture/adr/ADR-001-COMMERCIAL-FORK.md',
  'docs/02-architecture/adr/ADR-008-DATABASE-MIGRATION-POLICY.md',
  'src/App.tsx',
  'src/config/productConfig.ts',
  'server/index.mjs',
  'package-lock.json',
];
for (const item of required) await access(path.join(root, item));

const product = await readFile(path.join(root, required[0]), 'utf8');
const nfr = await readFile(path.join(root, required[1]), 'utf8');
const productIds = [...product.matchAll(/^### (WOS-[A-Z]+-\d{3})/gm)].map(match => match[1]);
const nfrIds = [...nfr.matchAll(/^### (WOS-NFR-[A-Z]+-\d{3})/gm)].map(match => match[1]);
if (productIds.length !== 126 || new Set(productIds).size !== 126) {
  throw new Error(`Expected exactly 126 unique product requirements, found ${productIds.length}/${new Set(productIds).size}`);
}
if (nfrIds.length !== 81 || new Set(nfrIds).size !== 81) {
  throw new Error(`Expected exactly 81 unique NFRs, found ${nfrIds.length}/${new Set(nfrIds).size}`);
}
const adrFiles = (await readdir(path.join(root, 'docs/02-architecture/adr')))
  .filter(name => /^ADR-00[1-8]-/.test(name));
if (adrFiles.length !== 8) throw new Error(`Expected ADR-001 through ADR-008, found ${adrFiles.length}`);

console.log(JSON.stringify({
  status: 'passed',
  productRequirements: productIds.length,
  nfrs: nfrIds.length,
  adrs: adrFiles.length,
}, null, 2));
