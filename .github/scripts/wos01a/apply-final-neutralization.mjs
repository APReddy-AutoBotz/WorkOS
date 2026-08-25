import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Usage: node apply-final-neutralization.mjs <publisher-script>');
const publisher = path.resolve(input);
let source = await readFile(publisher, 'utf8');

const replaceExactlyOnce = (search, replacement, label) => {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`Missing ${label} anchor`);
  if (source.indexOf(search, first + search.length) >= 0) throw new Error(`Ambiguous ${label} anchor`);
  source = source.slice(0, first) + replacement + source.slice(first + search.length);
};

replaceExactlyOnce(
  "  .replace('Shared UAT credentials are available only for testing and must be replaced by named production accounts before go-live.', 'Test identities are available only in explicit test mode; production requires named accounts and governed identity configuration.');\nawait writeFile(loginPage, loginText);",
  "  .replace('Shared UAT credentials are available only for testing and must be replaced by named production accounts before go-live.', 'Test identities are available only in explicit test mode; production requires named accounts and governed identity configuration.')\n  .replace('UAT seeded users use the configured demo password. Production must use named accounts and server-side password policies.', 'Test accounts require an explicitly supplied test password. Production uses named accounts and governed server-side password policy.')\n  .replace('UAT account shortcuts', 'Test account shortcuts')\n  .replaceAll(' / demo123', ' / password required')\n  .replace('multi-project demo', 'multi-project test account')\n  .replaceAll('Country Director mappings', 'regional ownership mappings');\nif (/demo123|Boundaryless|boundaryless\\.com/.test(loginText)) throw new Error('Unsafe or reference-company login copy remains');\nawait writeFile(loginPage, loginText);",
  'login neutralization',
);

replaceExactlyOnce(
  "if (/demo123|rut_session/.test(serverText)) throw new Error('Unsafe password/session fallback remains in server/index.mjs');\nawait writeFile(serverIndex, serverText);\n\nconst packageFile = path.join(targetRoot, 'package.json');",
  "if (/demo123|rut_session/.test(serverText)) throw new Error('Unsafe password/session fallback remains in server/index.mjs');\nawait writeFile(serverIndex, serverText);\n\nconst storageFile = path.join(targetRoot, 'src/services/storage.ts');\nlet storageText = await readFile(storageFile, 'utf8');\nconst neutralLegacyBlock = 'const LEGACY_DEMO_PERSON_NAMES = new Set<string>();';\nstorageText = storageText.replace(\n  /const LEGACY_DEMO_PERSON_NAMES = new Set\\(\\[[\\s\\S]*?\\]\\);/,\n  neutralLegacyBlock,\n);\nif (!storageText.includes(neutralLegacyBlock)) throw new Error('Legacy named-demo person block was not neutralized');\nstorageText = storageText\n  .replaceAll(\"sessionStorage.removeItem('rut_session')\", \"sessionStorage.removeItem('workos_session')\")\n  .replaceAll('boundaryless.demo', 'example.test');\nawait writeFile(storageFile, storageText);\n\nconst demoDataFile = path.join(targetRoot, 'src/services/demoData.ts');\nlet demoDataText = await readFile(demoDataFile, 'utf8');\ndemoDataText = demoDataText.replaceAll('boundaryless.demo', 'example.test');\nawait writeFile(demoDataFile, demoDataText);\n\nconst packageFile = path.join(targetRoot, 'package.json');",
  'legacy personal-data neutralization',
);

replaceExactlyOnce(
  "    .replaceAll('Boundaryless', 'WorkOS')\n    .replaceAll('boundaryless.com', 'example.test')\n    .replaceAll('boundaryless', 'workos')",
  "    .replaceAll('boundaryless.demo', 'example.test')\n    .replaceAll('Boundaryless', 'WorkOS')\n    .replaceAll('boundaryless.com', 'example.test')\n    .replaceAll('boundaryless', 'workos')",
  'demo-domain neutralization',
);

await writeFile(publisher, source);
execFileSync(process.execPath, ['--check', publisher], { stdio: 'inherit' });
console.log(`Applied bounded final neutralization patch to ${publisher}`);
