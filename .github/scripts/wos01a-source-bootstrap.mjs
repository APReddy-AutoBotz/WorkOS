import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const [sourceArg, targetArg, controllerArg] = process.argv.slice(2);
if (sourceArg !== '--verify-result-digest' && (!sourceArg || !targetArg || !controllerArg)) {
  throw new Error('Usage: node wos01a-source-bootstrap.mjs <reference-root> <workos-root> <controller-root>');
}

const sourceRoot = path.resolve(sourceArg);
const targetRoot = path.resolve(targetArg);
const controllerRoot = path.resolve(controllerArg || '.');
const EXPECTED_SOURCE = 'f2de1d85126f5d64f0e2e21b085b0303ca1d8417';
const EXPECTED_SOURCE_TREE = 'fdaa5d92854d378dae1c6146a8f09c7f34f8c273';
const EXPECTED_TARGET_PARENT = '7e4b5fad6e0d0d95ddd6c58015a787fb201d8661';
const SOURCE_REPOSITORY = 'APReddy-AutoBotz/Boundaryless-WorkOS';
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.csv', '.env', '.example', '.html', '.js', '.json', '.md', '.mjs', '.sql', '.ts', '.tsx', '.txt', '.yml', '.yaml',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const exists = async (file) => access(file).then(() => true).catch(() => false);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const walk = async (root) => {
  if (!(await exists(root))) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
};

const RESULT_DIGEST_EVIDENCE = 'docs/evidence/v0.2.0/DOC-WOS-01-001-SOURCE-BOOTSTRAP.md';
const resultDigest = async (root) => {
  const entries = [];
  for (const file of await walk(root)) {
    const relative = rel(root, file);
    if (relative === RESULT_DIGEST_EVIDENCE) continue;
    entries.push(`${relative}\0${sha256(await readFile(file))}`);
  }
  return sha256(Buffer.from(entries.join('\n')));
};

if (sourceArg === '--verify-result-digest') {
  const root = path.resolve(targetArg || '');
  const evidenceText = await readFile(path.join(root, RESULT_DIGEST_EVIDENCE), 'utf8');
  const recorded = evidenceText.match(/Result payload SHA-256: `([a-f0-9]{64})`/i)?.[1];
  const actual = await resultDigest(root);
  if (!recorded || recorded !== actual) throw new Error(`Result payload digest mismatch: recorded=${recorded || 'missing'} actual=${actual}`);
  console.log(JSON.stringify({ status: 'passed', resultDigest: actual }));
  process.exit(0);
}

const sourceHead = git(sourceRoot, ['rev-parse', 'HEAD']);
const sourceTree = git(sourceRoot, ['rev-parse', 'HEAD^{tree}']);
const targetHead = git(targetRoot, ['rev-parse', 'HEAD']);
if (sourceHead !== EXPECTED_SOURCE || sourceTree !== EXPECTED_SOURCE_TREE) {
  throw new Error(`Reference mismatch: ${sourceHead}/${sourceTree}`);
}
if (targetHead !== EXPECTED_TARGET_PARENT) {
  throw new Error(`Target branch moved: expected ${EXPECTED_TARGET_PARENT}, found ${targetHead}`);
}
if (git(sourceRoot, ['status', '--porcelain']) !== '') {
  throw new Error('Reference checkout is not clean');
}

const selectedRootFiles = [
  '.env.example',
  '.gitignore',
  'index.html',
  'metadata.json',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
];
const selectedServerFiles = [
  'server/index.mjs',
  'server/migrate.mjs',
  'server/schema.sql',
  'server/seed-demo.mjs',
  'server/start-production.mjs',
];
const selectedTestFiles = [
  'tests/access-control-smoke.mjs',
  'tests/approval-engine-smoke.mjs',
  'tests/backend-contract-smoke.mjs',
  'tests/ess-hub-smoke.mjs',
  'tests/import-template-smoke.mjs',
  'tests/integration-adapters-smoke.mjs',
  'tests/leave-management-smoke.mjs',
  'tests/notification-center-smoke.mjs',
  'tests/org-chart-smoke.mjs',
  'tests/phase7-scope-smoke.mjs',
  'tests/dynamic-permissions-smoke.mjs',
  'tests/requirements-smoke.mjs',
  'tests/resource-planning-smoke.mjs',
];

const sourceFiles = await walk(sourceRoot);
const selected = new Set();
for (const file of selectedRootFiles) if (await exists(path.join(sourceRoot, file))) selected.add(file);
for (const file of await walk(path.join(sourceRoot, 'src'))) selected.add(rel(sourceRoot, file));
for (const file of selectedServerFiles) if (await exists(path.join(sourceRoot, file))) selected.add(file);
for (const file of await walk(path.join(sourceRoot, 'server/migrations'))) selected.add(rel(sourceRoot, file));
for (const file of await walk(path.join(sourceRoot, 'templates/import'))) selected.add(rel(sourceRoot, file));
for (const file of selectedTestFiles) {
  if (!(await exists(path.join(sourceRoot, file)))) throw new Error(`Required retained test is absent: ${file}`);
  selected.add(file);
}

const controlledPaths = [
  '.env.example', '.gitignore', 'index.html', 'metadata.json', 'package-lock.json', 'package.json', 'tsconfig.json', 'vite.config.ts',
  'src', 'server', 'templates', 'tests', 'public',
  'scripts/scan-bootstrap.mjs', 'scripts/verify-baseline.mjs',
  'docs/00-control/SOURCE_IMPORT_MANIFEST.md',
  'docs/evidence/v0.2.0/DOC-WOS-01-001-SOURCE-BOOTSTRAP.md',
];
for (const controlled of controlledPaths) await rm(path.join(targetRoot, controlled), { recursive: true, force: true });

for (const sourcePath of [...selected].sort()) {
  const from = path.join(sourceRoot, sourcePath);
  const to = path.join(targetRoot, sourcePath);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { force: true, preserveTimestamps: false });
}

const oldMigration = path.join(targetRoot, 'server/migrations/006_boundaryless_workos_prod_core.sql');
const newMigration = path.join(targetRoot, 'server/migrations/006_workos_prod_core.sql');
if (await exists(oldMigration)) await rename(oldMigration, newMigration);

const replaceRequired = async (file, search, replacement, label) => {
  const current = await readFile(file, 'utf8');
  const next = current.replace(search, replacement);
  if (next === current) throw new Error(`Required transform not applied (${label}) in ${rel(targetRoot, file)}`);
  await writeFile(file, next);
};

const apiClient = path.join(targetRoot, 'src/services/apiClient.ts');
await replaceRequired(
  apiClient,
  "const frontendEnv = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env || {});\nconst appMode = frontendEnv.VITE_APP_MODE || frontendEnv.APP_MODE || 'demo';\nconst disableDemoFallback = frontendEnv.VITE_DISABLE_DEMO_FALLBACK || frontendEnv.DISABLE_DEMO_FALLBACK;\n\nexport const isDemoFallbackAllowed = () =>\n  appMode !== 'production' && String(disableDemoFallback || '').toLowerCase() !== 'true';",
  "const frontendEnv = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env || {});\nconst processEnv = ((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env || {});\nconst appMode = frontendEnv.VITE_APP_MODE || frontendEnv.APP_MODE || processEnv.VITE_APP_MODE || processEnv.APP_MODE || 'production';\nconst allowTestFallback = frontendEnv.VITE_ALLOW_TEST_FALLBACK || frontendEnv.ALLOW_TEST_FALLBACK || processEnv.VITE_ALLOW_TEST_FALLBACK || processEnv.ALLOW_TEST_FALLBACK;\n\nexport const isDemoFallbackAllowed = () =>\n  appMode === 'test' && String(allowTestFallback || '').toLowerCase() === 'true';",
  'fail-closed API fallback',
);

const authService = path.join(targetRoot, 'src/services/authService.ts');
let authText = await readFile(authService, 'utf8');
authText = authText
  .replace("const DEMO_PASSWORD = 'demo123';\n", '')
  .replace("const SESSION_KEY = 'rut_session';", "const SESSION_KEY = 'workos_session';")
  .replace(/\n\s*getDemoPassword:\s*\(\)\s*=>\s*DEMO_PASSWORD,\n/, '\n');
if (/demo123|getDemoPassword/.test(authText)) throw new Error('Shared demo password remains in authService');
await writeFile(authService, authText);

await mkdir(path.join(targetRoot, 'src/config'), { recursive: true });
await writeFile(path.join(targetRoot, 'src/config/productConfig.ts'), `const frontendEnv = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env || {});

const valueOr = (key: string, fallback: string) => {
  const value = String(frontendEnv[key] || '').trim();
  return value || fallback;
};

export const productConfig = Object.freeze({
  productName: valueOr('VITE_PRODUCT_NAME', 'WorkOS'),
  organizationName: valueOr('VITE_ORGANIZATION_NAME', 'Your organization'),
  logoUrl: valueOr('VITE_PRODUCT_LOGO_URL', '/workos-mark.svg'),
  supportName: valueOr('VITE_SUPPORT_NAME', valueOr('VITE_PRODUCT_NAME', 'WorkOS') + ' Support'),
  supportEmail: valueOr('VITE_SUPPORT_EMAIL', 'support@example.test'),
});
`);

const centralizeRuntimeBranding = (source, targetPath) => {
  if (!/^src\/.*\.(?:ts|tsx)$/.test(targetPath) || targetPath === 'src/config/productConfig.ts') return source;
  const substitutions = [
    ['My WorkOS Hub', 'My ${productConfig.productName} Hub'],
    ['Boundaryless-WorkOS', '${productConfig.productName}'],
    ['Boundaryless WorkOS', '${productConfig.productName}'],
    ['Configured product', '${productConfig.productName}'],
    ['Boundaryless', '${productConfig.organizationName}'],
    ['Your organization', '${productConfig.organizationName}'],
  ];
  let next = source;
  let changed = false;
  next = next.replace(/(['"])([^'"\r\n]*(?:My WorkOS Hub|Boundaryless-WorkOS|Boundaryless WorkOS|Configured product|Boundaryless|Your organization)[^'"\r\n]*)\1/g, (_match, _quote, value) => {
    let replacement = value.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${');
    for (const [label, expression] of substitutions) replacement = replacement.replaceAll(label, expression);
    changed = true;
    return `\`${replacement}\``;
  });
  if (!changed || /(?:^|\n)import\s+\{\s*productConfig\s*\}/.test(next)) return next;
  const depth = targetPath.slice('src/'.length).split('/').length - 1;
  const configPath = `${'../'.repeat(depth)}config/productConfig`;
  const imports = [...next.matchAll(/^import[^\n]*;\s*$/gm)];
  if (!imports.length) throw new Error(`Cannot insert productConfig import in ${targetPath}`);
  const lastImport = imports.at(-1);
  const insertAt = lastImport.index + lastImport[0].length;
  return `${next.slice(0, insertAt)}\nimport { productConfig } from '${configPath}';${next.slice(insertAt)}`;
};

const loginPage = path.join(targetRoot, 'src/pages/Login.tsx');
let loginText = await readFile(loginPage, 'utf8');
loginText = loginText
  .replace("import { isDemoFallbackAllowed } from '../services/apiClient';", "import { isDemoFallbackAllowed } from '../services/apiClient';\nimport { productConfig } from '../config/productConfig';")
  .replace("setPassword(authService.getDemoPassword());", "setPassword('');")
  .replace(/<img\s+src="\/boundaryless-logo\.png"[^>]*\/>/g, '<img src={productConfig.logoUrl} alt={productConfig.productName} className="h-10 w-auto object-contain" />')
  .replace('Authorized Internal Access', 'Authorized {productConfig.productName} Access')
  .replace('Boundaryless-WorkOS Workforce Operations Core', '{productConfig.productName} Professional Services Operations')
  .replace('Internal workforce planning workspace', 'Professional-services operations workspace')
  .replace('Internal workspace access', '{productConfig.productName} workspace access')
  .replace('Shared UAT credentials are available only for testing and must be replaced by named production accounts before go-live.', 'Test identities are available only in explicit test mode; production requires named accounts and governed identity configuration.');
await writeFile(loginPage, loginText);

const sidebarFile = path.join(targetRoot, 'src/components/Layout/Sidebar.tsx');
let sidebarText = await readFile(sidebarFile, 'utf8');
sidebarText = sidebarText
  .replace("import { EnterpriseFeatureFlag, isEnterpriseFeatureEnabled } from '../../config/featureFlags';", "import { EnterpriseFeatureFlag, isEnterpriseFeatureEnabled } from '../../config/featureFlags';\nimport { productConfig } from '../../config/productConfig';")
  .replace("{ name: 'My WorkOS Hub', path: '/ess', icon: LayoutDashboard, roles: ROUTE_ROLES.employeeWorkspace, navRoles: ['Employee'] },", "{ name: `My ${productConfig.productName} Hub`, path: '/ess', icon: LayoutDashboard, roles: ROUTE_ROLES.employeeWorkspace, navRoles: ['Employee'] },")
  .replace('<img src="/boundaryless-mark.png" alt="Boundaryless" className="w-7 h-7 object-contain" />', '<img src={productConfig.logoUrl} alt={productConfig.productName} className="w-7 h-7 object-contain" />')
  .replace('<img src="/boundaryless-logo.png" alt="Boundaryless" className="h-full w-full object-contain" />', '<img src={productConfig.logoUrl} alt={productConfig.productName} className="h-full w-full object-contain" />');
await writeFile(sidebarFile, sidebarText);

const indexFile = path.join(targetRoot, 'index.html');
let indexText = await readFile(indexFile, 'utf8');
indexText = indexText
  .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/svg+xml" href="%VITE_PRODUCT_LOGO_URL%" />')
  .replace(/\n\s*<link rel="alternate icon"[^>]*>/, '')
  .replace(/\n\s*<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '')
  .replace(/<title>[^<]*<\/title>/, '<title>%VITE_PRODUCT_NAME%</title>');
await writeFile(indexFile, indexText);

const cssFile = path.join(targetRoot, 'src/index.css');
if (await exists(cssFile)) {
  const cssText = await readFile(cssFile, 'utf8');
  await writeFile(cssFile, cssText.replace(/^\s*@import\s+(?:url\()?['"]?https:\/\/fonts\.(?:googleapis|gstatic)\.com[^;]*;\s*$/gim, ''));
}

const seedDemo = path.join(targetRoot, 'server/seed-demo.mjs');
let seedText = await readFile(seedDemo, 'utf8');
seedText = seedText
  .replace(
    "const reset = process.argv.includes('--reset') || process.env.RESET_DEMO_DATA === 'true';\nconst password = process.env.DEMO_SEED_PASSWORD || 'demo123';",
    "const reset = process.argv.includes('--reset') || process.env.RESET_DEMO_DATA === 'true';\nif (process.env.NODE_ENV === 'production' || process.env.APP_MODE === 'production') {\n  throw new Error('Demo seeding is prohibited in production.');\n}\nconst password = String(process.env.DEMO_SEED_PASSWORD || '');\nif (!password) throw new Error('DEMO_SEED_PASSWORD is required for explicit non-production demo seeding.');",
  )
  .replace(/\n\s*demoPassword:\s*password,/, '');
if (/demo123|demoPassword:\s*password/.test(seedText)) throw new Error('Unsafe demo password remains in seed-demo');
await writeFile(seedDemo, seedText);

await writeFile(path.join(targetRoot, 'server/start-production.mjs'), `import 'dotenv/config';

process.env.NODE_ENV = 'production';
process.env.APP_MODE = 'production';

if (String(process.env.AUTO_SEED_DEMO || '').toLowerCase() === 'true') {
  throw new Error('AUTO_SEED_DEMO is prohibited in production.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
if (!process.env.API_SESSION_SECRET || process.env.API_SESSION_SECRET === 'dev-only-change-me') {
  throw new Error('A non-default API_SESSION_SECRET is required in production.');
}
const identityProvider = String(process.env.IDENTITY_PROVIDER || '').trim().toLowerCase();
if (!['entra', 'oidc'].includes(identityProvider)) {
  throw new Error('IDENTITY_PROVIDER must select a governed non-local provider (entra or oidc) in production.');
}
const requiredIdentitySettings = identityProvider === 'entra'
  ? ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI']
  : ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'];
for (const setting of requiredIdentitySettings) {
  if (!String(process.env[setting] || '').trim()) throw new Error(setting + ' is required in production.');
}
process.env.LOCAL_LOGIN_ENABLED = 'false';

await import('./migrate.mjs');
await import('./index.mjs');
`);

const serverIndex = path.join(targetRoot, 'server/index.mjs');
let serverText = await readFile(serverIndex, 'utf8');
const localLoginRoute = /app\.post\((['"])\/api\/auth\/login\1,\s*(?:(?:[A-Za-z_$][\w$]*),\s*)*async\s*\(req,\s*res\)\s*=>\s*\{/;
const localLoginMatches = serverText.match(new RegExp(localLoginRoute.source, 'g')) || [];
if (localLoginMatches.length !== 1) throw new Error(`Expected one local-login route, found ${localLoginMatches.length}`);
serverText = serverText
  .replace(localLoginRoute, match => `${match}\n  if (process.env.NODE_ENV === 'production' || process.env.LOCAL_LOGIN_ENABLED === 'false') return res.status(404).json({ error: 'Not found' });`)
  .replace("readCookie(req, 'rut_session')", "readCookie(req, 'workos_session')")
  .replaceAll("'rut_session'", "'workos_session'")
  .replace(
    "const passwordHash = existingUser && !parsed.data.initial_password\n      ? null\n      : await scryptHash(parsed.data.initial_password || process.env.DEMO_SEED_PASSWORD || 'demo123');",
    "if (!existingUser && !parsed.data.initial_password) {\n      throw new Error('initial_password is required when creating a new user.');\n    }\n    const passwordHash = existingUser && !parsed.data.initial_password\n      ? null\n      : await scryptHash(parsed.data.initial_password);",
  )
  .replace(
    "const passwordHash = existingUser ? null : await scryptHash(row.initialPassword || process.env.DEMO_SEED_PASSWORD || 'demo123');",
    "if (!existingUser && !row.initialPassword) {\n        throw new Error(`initialPassword is required for new user ${row.employeeId}`);\n      }\n      const passwordHash = existingUser ? null : await scryptHash(row.initialPassword);",
  );
if (/demo123|rut_session/.test(serverText)) throw new Error('Unsafe password/session fallback remains in server/index.mjs');
await writeFile(serverIndex, serverText);

const packageFile = path.join(targetRoot, 'package.json');
const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
const configuredLintScript = pkg.scripts?.lint;
pkg.name = 'workos';
pkg.description = 'Buyer-owned professional-services operations platform';
pkg.scripts.typecheck = 'tsc --noEmit';
pkg.scripts['test:wos00-baseline'] = 'node scripts/verify-baseline.mjs';
pkg.scripts['test:bootstrap-scan'] = 'node scripts/scan-bootstrap.mjs';
const safeTestScripts = [
  'test:requirements', 'test:access', 'test:ess', 'test:leave', 'test:backend', 'test:approvals',
  'test:notifications', 'test:integrations', 'test:planning', 'test:phase7-scope', 'test:org-chart',
  'test:permissions', 'test:import-templates',
].filter(name => pkg.scripts[name]);
pkg.scripts.test = safeTestScripts.map(name => `npm run ${name}`).join(' && ');
await writeFile(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

const lockFile = path.join(targetRoot, 'package-lock.json');
const lock = JSON.parse(await readFile(lockFile, 'utf8'));
lock.name = 'workos';
if (lock.packages?.['']) lock.packages[''].name = 'workos';
await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);

await writeFile(path.join(targetRoot, '.env.example'), `# WorkOS local/test example only. Never place real credentials in source.
APP_MODE=development
NODE_ENV=development
PORT=4000
APP_URL=http://localhost:3000
DATABASE_URL=postgres://workos:workos@localhost:5432/workos
PGSSLMODE=disable
API_SESSION_SECRET=
LOGIN_RATE_LIMIT=8
AUTO_SEED_DEMO=false
RESET_DEMO_DATA=false
DEMO_SEED_PASSWORD=
VITE_APP_MODE=development
VITE_ALLOW_TEST_FALLBACK=false
VITE_PRODUCT_NAME=WorkOS
VITE_ORGANIZATION_NAME=Your organization
VITE_PRODUCT_LOGO_URL=/workos-mark.svg
VITE_SUPPORT_NAME=WorkOS Support
VITE_SUPPORT_EMAIL=support@example.test
IDENTITY_PROVIDER=
ENTRA_ENABLED=false
ENTRA_TENANT_ID=
ENTRA_CLIENT_ID=
ENTRA_CLIENT_SECRET=
ENTRA_REDIRECT_URI=http://localhost:4000/api/auth/entra/callback
OIDC_ISSUER_URL=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=http://localhost:4000/api/auth/oidc/callback
TEAMS_ENABLED=false
TEAMS_WEBHOOK_URL=
`);

await writeFile(path.join(targetRoot, 'metadata.json'), `${JSON.stringify({ name: 'WorkOS', description: 'Buyer-owned professional-services operations platform' }, null, 2)}\n`);
await mkdir(path.join(targetRoot, 'public'), { recursive: true });
await writeFile(path.join(targetRoot, 'public/workos-mark.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="WorkOS"><rect width="128" height="128" rx="28" fill="#0f172a"/><path d="M25 38h16l10 45 13-34h14l12 34 9-45h16L99 96H84L71 64 58 96H43z" fill="#f97316"/></svg>\n`);
await writeFile(path.join(targetRoot, 'public/login-workspace-bg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0f172a"/><stop offset="1" stop-color="#e2e8f0"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><g fill="none" stroke="#f97316" stroke-opacity=".18"><circle cx="180" cy="160" r="120"/><circle cx="980" cy="620" r="220"/><path d="M0 520C260 360 430 690 700 490s360-230 500-170"/></g></svg>\n`);

const brandingTargets = new Set(
  [...selected].map(sourcePath => sourcePath === 'server/migrations/006_boundaryless_workos_prod_core.sql'
    ? 'server/migrations/006_workos_prod_core.sql'
    : sourcePath),
);
brandingTargets.add('public/workos-mark.svg');
brandingTargets.add('public/login-workspace-bg.svg');
brandingTargets.add('src/config/productConfig.ts');
for (const targetPath of [...brandingTargets].sort()) {
  const file = path.join(targetRoot, targetPath);
  if (!(await exists(file))) continue;
  const extension = path.extname(file);
  if (!TEXT_EXTENSIONS.has(extension) && !file.endsWith('.env.example')) continue;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  const original = text;
  text = text
    .replaceAll('Boundaryless-WorkOS', 'Configured product')
    .replaceAll('Boundaryless WorkOS', 'Configured product')
    .replaceAll('BOUNDARYLESS_WORKOS', 'CONFIGURED_PRODUCT')
    .replaceAll('boundaryless-workos', 'configured-product')
    .replaceAll('boundaryless_workos', 'configured_product')
    .replaceAll('Boundaryless', 'Your organization')
    .replaceAll('boundaryless.com', 'example.test')
    .replaceAll('boundaryless', 'your-organization')
    .replaceAll('/workos-logo.png', '/workos-mark.svg')
    .replaceAll('/workos-logo-mini.png', '/workos-mark.svg')
    .replaceAll('/workos-wordmark.png', '/workos-mark.svg')
    .replaceAll('RUT-${', 'WOS-${')
    .replaceAll("'rut_", "'workos_")
    .replaceAll("'rt_", "'workos_")
    .replaceAll("'bw_", "'workos_");
  text = centralizeRuntimeBranding(text, targetPath);
  if (/src\/services\/(storage|demoData)\.ts$/.test(targetPath)) {
    text = text.replaceAll('BL-', 'WOS-');
  }
  if (text !== original) await writeFile(file, text);
}

await mkdir(path.join(targetRoot, 'scripts'), { recursive: true });
await cp(path.join(controllerRoot, '.github/scripts/wos01a/verify-baseline.mjs'), path.join(targetRoot, 'scripts/verify-baseline.mjs'));
await cp(path.join(controllerRoot, '.github/scripts/wos01a/scan-bootstrap.mjs'), path.join(targetRoot, 'scripts/scan-bootstrap.mjs'));

const runResults = [];
const runCheck = (name, command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: targetRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 15 * 60 * 1000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-12000);
  const status = result.status === 0 ? 'PASS' : options.optional ? 'NOT RUN' : 'FAIL';
  runResults.push({ name, status, output });
  if (status === 'FAIL') throw new Error(`${name} failed:\n${output}`);
};

runCheck('Node syntax', 'bash', ['-lc', "find server scripts tests -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check"]);
runCheck('WOS-00 baseline verifier', 'node', ['scripts/verify-baseline.mjs']);
runCheck('Bootstrap security scan', 'node', ['scripts/scan-bootstrap.mjs']);
runCheck('Locked dependency installation', 'npm', ['ci', '--ignore-scripts'], { timeout: 20 * 60 * 1000 });
runCheck('Type check', 'npm', ['run', 'typecheck']);
if (configuredLintScript) {
  runCheck('Lint', 'npm', ['run', 'lint']);
} else {
  runResults.push({ name: 'Lint', status: 'NOT RUN', output: 'The authorized source package does not configure a lint script.' });
}
runCheck('Production build', 'npm', ['run', 'build']);
runCheck('Retained safe test suite', 'npm', ['test'], {
  timeout: 20 * 60 * 1000,
  env: {
    NODE_ENV: 'test',
    APP_MODE: 'test',
    VITE_APP_MODE: 'test',
    ALLOW_TEST_FALLBACK: 'true',
    VITE_ALLOW_TEST_FALLBACK: 'true',
  },
});
runResults.push({ name: 'Fresh/upgrade database migrations', status: 'NOT RUN', output: 'No disposable PostgreSQL service is provisioned by the source-bootstrap publisher.' });
runResults.push({ name: 'Production startup and browser journeys', status: 'NOT RUN', output: 'Requires a disposable database and separate hosted/browser acceptance task.' });

const inventoryRows = [];
for (const sourceFile of sourceFiles) {
  const sourcePath = rel(sourceRoot, sourceFile);
  const bytes = await readFile(sourceFile);
  const isIncluded = selected.has(sourcePath);
  const targetPath = sourcePath === 'server/migrations/006_boundaryless_workos_prod_core.sql'
    ? 'server/migrations/006_workos_prod_core.sql'
    : sourcePath;
  const targetFile = path.join(targetRoot, targetPath);
  const targetBytes = isIncluded && await exists(targetFile) ? await readFile(targetFile) : null;
  let reason = 'Approved application/build/test/schema source';
  if (!isIncluded) {
    if (/^(?:artifacts|docs|screenshots|presentations|generated|node_modules|dist)\//i.test(sourcePath)) reason = 'Generated, transient or company-only collateral';
    else if (/seed-uat|microsoft-live|real-data-cutover|role-browser-uat|browser-ux|credential-handover|backend-uat|prod-readiness|prod-core|production-hardening|audit-governance|operations-readiness/i.test(sourcePath)) reason = 'Live-environment, company-evidence or UAT-only test/artifact';
    else reason = 'Outside the bounded application-source allowlist';
  }
  inventoryRows.push({
    sourcePath,
    targetPath: isIncluded ? targetPath : '',
    decision: isIncluded ? 'INCLUDE' : 'EXCLUDE',
    reason,
    sourceSha256: sha256(bytes),
    resultSha256: targetBytes ? sha256(targetBytes) : '',
    changed: targetBytes ? sha256(bytes) !== sha256(targetBytes) : false,
  });
}

const includedCount = inventoryRows.filter(row => row.decision === 'INCLUDE').length;
const excludedCount = inventoryRows.length - includedCount;
const inventoryDigest = sha256(Buffer.from(JSON.stringify(inventoryRows)));
const table = inventoryRows.map(row => `| ${row.decision} | \`${row.sourcePath}\` | ${row.targetPath ? `\`${row.targetPath}\`` : '—'} | ${row.reason} | \`${row.sourceSha256}\` | ${row.resultSha256 ? `\`${row.resultSha256}\`` : '—'} |`).join('\n');
const manifest = `# WorkOS Source Import Manifest\n\n- Authorized source: \`${SOURCE_REPOSITORY}@${EXPECTED_SOURCE}\`\n- Authorized source tree: \`${EXPECTED_SOURCE_TREE}\`\n- WorkOS parent: \`${EXPECTED_TARGET_PARENT}\`\n- Inventory: ${inventoryRows.length} entries — ${includedCount} included / ${excludedCount} excluded\n- Inventory SHA-256: \`${inventoryDigest}\`\n- Import mode: approved bytes only; no source Git history\n- Reference access: read-only; source checkout remained clean\n\n| Decision | Source | Target | Reason | Source SHA-256 | Result SHA-256 |\n|---|---|---|---|---|---|\n${table}\n`;
await mkdir(path.join(targetRoot, 'docs/00-control'), { recursive: true });
await writeFile(path.join(targetRoot, 'docs/00-control/SOURCE_IMPORT_MANIFEST.md'), manifest);

const checksTable = runResults.map(item => `| ${item.name} | ${item.status} | ${item.output ? item.output.replaceAll('|', '\\|').replaceAll('\n', '<br>') : '—'} |`).join('\n');
const changedPaths = git(targetRoot, ['status', '--short']).split('\n').filter(Boolean).length;
const materializedResultDigest = await resultDigest(targetRoot);
const evidence = `# DOC-WOS-01-001 — Authorized Source Bootstrap\n\n## Authority\n\n- Workstream: WOS-01A\n- Draft PR: #16\n- Accepted base: \`${EXPECTED_TARGET_PARENT}\`\n- Authorized reference: \`${SOURCE_REPOSITORY}@${EXPECTED_SOURCE}\`\n- Source tree: \`${EXPECTED_SOURCE_TREE}\`\n- Reference mode: read-only; no Git-history import\n- Changed paths before commit: ${changedPaths}\n- Result payload SHA-256: \`${materializedResultDigest}\`\n- Result digest scope: deterministic path/content hashes for the fully materialized worktree, excluding only this self-referential evidence file and Git metadata\n\n## Outcome\n\nImported the bounded application, build, dependency, PostgreSQL schema/migrations, synthetic import templates and retained safe tests. Company collateral, live-environment evidence, credentials, production values and source history remain excluded. Runtime identity was neutralized to centrally configured WorkOS defaults; production fallback and automatic demo seeding fail closed; new users require explicit passwords.\n\n## Check matrix\n\n| Check | Result | Evidence |\n|---|---|---|\n${checksTable}\n\n## Frozen A–I closure\n\n- **A — Application path:** production build and retained safe tests pass from the imported toolchain.\n- **B — Authorization/security:** no reference-repository write, shared credential, private key, production URL or automatic production demo fallback is accepted.\n- **C — Concurrency:** imported database constraints, transactions and existing concurrency semantics are retained unchanged except bounded security neutralization.\n- **D — Replay/idempotency:** inherited idempotency contracts remain present; no bootstrap operation silently retries a partial import.\n- **E — Lifecycle:** WOS-00 governing approval, commercial and notification documents remain untouched and authoritative.\n- **F — Partial failure:** this publisher exits before commit/push on any mandatory install/build/test/scan failure.\n- **G — Bounds:** generated caches, artifacts, collateral and live-data fixtures are excluded.\n- **H — Fallback:** local fallback is allowed only when app mode is exactly test and explicit fallback opt-in is true; production configuration fails closed.\n- **I — Evidence:** 126 requirements, 81 NFRs, ADR-001..008, source hashes and the exact changed scope are reproducible.\n\n## Limitations\n\nDatabase migration execution, production startup and browser journeys require a later disposable-environment acceptance gate and are explicitly NOT RUN here. WOS-01A remains Draft until an independent exact-head review and clean-runtime merge boundary are satisfied.\n\n## Rollback\n\nBefore merge, reset the Draft branch to \`${EXPECTED_TARGET_PARENT}\`. After merge, use a reviewed revert/forward correction; never rewrite source provenance or accepted history.\n`;
await mkdir(path.join(targetRoot, 'docs/evidence/v0.2.0'), { recursive: true });
await writeFile(path.join(targetRoot, 'docs/evidence/v0.2.0/DOC-WOS-01-001-SOURCE-BOOTSTRAP.md'), evidence);

runCheck('Final WOS-00 baseline verifier', 'node', ['scripts/verify-baseline.mjs']);
runCheck('Final bootstrap security scan', 'node', ['scripts/scan-bootstrap.mjs']);
runCheck('Git diff check', 'git', ['diff', '--check']);

const finalChanged = git(targetRoot, ['status', '--short']).split('\n').filter(Boolean);
if (finalChanged.length < 80) throw new Error(`Unexpectedly small source bootstrap: ${finalChanged.length} changed paths`);
console.log(JSON.stringify({
  sourceHead,
  sourceTree,
  targetHead,
  inventoryEntries: inventoryRows.length,
  includedCount,
  excludedCount,
  changedPaths: finalChanged.length,
  checks: runResults.map(({ name, status }) => ({ name, status })),
}, null, 2));
