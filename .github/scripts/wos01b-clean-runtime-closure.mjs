import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const targetArg = process.argv[2];
if (!targetArg) throw new Error('Usage: node wos01b-clean-runtime-closure.mjs <workos-root>');

const targetRoot = path.resolve(targetArg);
const EXPECTED_PARENT = '590bc6a6d28ac185e4c4a0dd486649f3a8c9cc60';
const EVIDENCE_PATH = 'docs/evidence/v0.2.1/DOC-WOS-01-002-CLEAN-RUNTIME-CLOSURE.md';
const changedPathsExpected = [
  'docs/evidence/v0.2.1/DOC-WOS-01-002-CLEAN-RUNTIME-CLOSURE.md',
  'index.html',
  'package-lock.json',
  'package.json',
  'src/main.tsx',
  'tests/product-identity-smoke.mjs',
].sort();

const sha256 = value => createHash('sha256').update(value).digest('hex');
const exists = file => access(file).then(() => true).catch(() => false);
const git = args => execFileSync('git', args, { cwd: targetRoot, encoding: 'utf8' }).trim();
const run = (name, command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: targetRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 20 * 60 * 1000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit ${result.status}:\n${output.slice(-16000)}`);
  }
  return output;
};
const runAllowFailure = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: targetRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 20 * 60 * 1000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
};

const parseVersionList = raw => {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const stable = list.filter(value => /^\d+\.\d+\.\d+$/.test(String(value)));
  if (stable.length === 0) throw new Error(`No stable version found in ${raw}`);
  const compare = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (pa[index] !== pb[index]) return pa[index] - pb[index];
    }
    return 0;
  };
  return stable.sort(compare).at(-1);
};

const npmLatestMajor = majorSpec => parseVersionList(
  execFileSync('npm', ['view', majorSpec, 'version', '--json'], {
    cwd: targetRoot,
    encoding: 'utf8',
    timeout: 2 * 60 * 1000,
  }),
);

const auditCounts = audit => {
  const values = audit?.metadata?.vulnerabilities || {};
  return {
    info: Number(values.info || 0),
    low: Number(values.low || 0),
    moderate: Number(values.moderate || 0),
    high: Number(values.high || 0),
    critical: Number(values.critical || 0),
    total: Number(values.total || 0),
  };
};

const audit = omitDev => {
  const args = ['audit'];
  if (omitDev) args.push('--omit=dev');
  args.push('--json');
  const result = runAllowFailure('npm', args, { timeout: 5 * 60 * 1000 });
  let parsed;
  try {
    parsed = JSON.parse(result.output);
  } catch (error) {
    throw new Error(`npm audit JSON was not parseable: ${error.message}\n${result.output.slice(-8000)}`);
  }
  return {
    commandExit: result.status,
    counts: auditCounts(parsed),
    packages: Object.entries(parsed.vulnerabilities || {})
      .map(([name, value]) => ({
        name,
        severity: value.severity,
        direct: Boolean(value.isDirect),
        range: value.range,
        fixAvailable: value.fixAvailable,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

const changedPaths = () => {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: targetRoot,
    encoding: 'utf8',
  });
  const records = raw.split('\0');
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error(`Unexpected Git status record: ${JSON.stringify(record)}`);
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return paths.sort();
};

const walk = async root => {
  if (!(await exists(root))) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
};

const resultDigest = async () => {
  const entries = [];
  for (const file of await walk(targetRoot)) {
    const relative = path.relative(targetRoot, file).split(path.sep).join('/');
    if (relative === EVIDENCE_PATH) continue;
    entries.push(`${relative}\0${sha256(await readFile(file))}`);
  }
  return sha256(Buffer.from(entries.join('\n')));
};

if (git(['rev-parse', 'HEAD']) !== EXPECTED_PARENT) {
  throw new Error(`Target moved: expected ${EXPECTED_PARENT}, found ${git(['rev-parse', 'HEAD'])}`);
}
if (git(['status', '--porcelain']) !== '') throw new Error('Target worktree is not clean');
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) throw new Error('Construction step must not receive a repository credential');

const beforeFull = audit(false);
const beforeProduction = audit(true);
if (beforeProduction.counts.high !== 5 || beforeProduction.counts.critical !== 0) {
  throw new Error(`Unexpected starting production audit: ${JSON.stringify(beforeProduction.counts)}`);
}

const selectedVersions = {
  express: npmLatestMajor('express@4'),
  reactRouterDom: npmLatestMajor('react-router-dom@7'),
  vite: npmLatestMajor('vite@6'),
};

const packageFile = path.join(targetRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
packageJson.dependencies.express = selectedVersions.express;
packageJson.dependencies['react-router-dom'] = selectedVersions.reactRouterDom;
packageJson.dependencies.vite = selectedVersions.vite;
packageJson.devDependencies.vite = selectedVersions.vite;
packageJson.scripts['test:product-identity'] = 'node tests/product-identity-smoke.mjs';
if (!packageJson.scripts.test.includes('npm run test:product-identity')) {
  packageJson.scripts.test = `${packageJson.scripts.test} && npm run test:product-identity`;
}
await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

run('Refresh package lock', 'npm', ['install', '--package-lock-only', '--ignore-scripts'], { timeout: 10 * 60 * 1000 });
const auditFix = runAllowFailure('npm', ['audit', 'fix', '--package-lock-only', '--ignore-scripts'], { timeout: 10 * 60 * 1000 });
if (![0, 1].includes(auditFix.status)) {
  throw new Error(`npm audit fix failed unexpectedly with ${auditFix.status}:\n${auditFix.output.slice(-12000)}`);
}

const indexFile = path.join(targetRoot, 'index.html');
const originalIndex = await readFile(indexFile, 'utf8');
const expectedIndex = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <link id="workos-favicon" rel="icon" type="image/svg+xml" href="/workos-mark.svg" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>WorkOS</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n';
if (!originalIndex.includes('%VITE_PRODUCT_NAME%') || !originalIndex.includes('%VITE_PRODUCT_LOGO_URL%')) {
  throw new Error('Default HTML branding anchors are absent or already changed');
}
await writeFile(indexFile, expectedIndex);

const mainFile = path.join(targetRoot, 'src/main.tsx');
const originalMain = await readFile(mainFile, 'utf8');
const expectedMain = "import {StrictMode} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from './App.tsx';\nimport {productConfig} from './config/productConfig';\nimport {DataStorage} from './services/storage';\nimport './index.css';\n\nconst applyProductIdentity = () => {\n  document.title = productConfig.productName;\n  const favicon = document.querySelector<HTMLLinkElement>('link#workos-favicon');\n  if (favicon) favicon.href = productConfig.logoUrl;\n};\n\napplyProductIdentity();\nDataStorage.initialize();\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n";
if (!originalMain.includes('DataStorage.initialize();') || originalMain.includes('applyProductIdentity')) {
  throw new Error('Frontend identity bootstrap anchors are absent or already changed');
}
await writeFile(mainFile, expectedMain);

const identityTest = `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n\nconst indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');\nconst mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');\nconst configSource = readFileSync(new URL('../src/config/productConfig.ts', import.meta.url), 'utf8');\n\nassert.doesNotMatch(indexHtml, /%VITE_[A-Z0-9_]+%/, 'default HTML must not ship unresolved Vite placeholders');\nassert.match(indexHtml, /<title>WorkOS<\\/title>/, 'default HTML must expose the WorkOS title');\nassert.match(indexHtml, /id="workos-favicon"[\\s\\S]*href="\\/workos-mark\\.svg"/, 'default HTML must expose the WorkOS favicon');\nassert.match(mainSource, /productConfig/, 'runtime bootstrap must consume governed product configuration');\nassert.match(mainSource, /document\\.title = productConfig\\.productName/, 'configured product name must update the document title');\nassert.match(mainSource, /favicon\\.href = productConfig\\.logoUrl/, 'configured logo must update the favicon');\nassert.match(configSource, /valueOr\\('VITE_PRODUCT_NAME', 'WorkOS'\\)/, 'product name must retain a safe WorkOS default');\nassert.match(configSource, /valueOr\\('VITE_PRODUCT_LOGO_URL', '\\/workos-mark\\.svg'\\)/, 'logo must retain a safe WorkOS default');\n\nconsole.log(JSON.stringify({ status: 'passed', defaultTitle: 'WorkOS', defaultLogo: '/workos-mark.svg', configuredRuntimeIdentity: true }, null, 2));\n`;
await writeFile(path.join(targetRoot, 'tests/product-identity-smoke.mjs'), identityTest);

await rm(path.join(targetRoot, 'node_modules'), { recursive: true, force: true });
run('Locked dependency installation', 'npm', ['ci', '--ignore-scripts'], { timeout: 15 * 60 * 1000 });

const afterFull = audit(false);
const afterProduction = audit(true);
if (afterProduction.counts.high > 0 || afterProduction.counts.critical > 0) {
  throw new Error(`Production high/critical advisories remain: ${JSON.stringify(afterProduction)}`);
}

const testEnv = {
  NODE_ENV: 'test',
  APP_MODE: 'test',
  VITE_APP_MODE: 'test',
  ALLOW_TEST_FALLBACK: 'true',
  VITE_ALLOW_TEST_FALLBACK: 'true',
};
const checks = [];
const checked = (name, command, args, options = {}) => {
  const output = run(name, command, args, options);
  checks.push({ name, status: 'PASS', output: output.slice(-4000) });
};
checked('Type check', 'npm', ['run', 'typecheck']);
checked('Configured lint', 'npm', ['run', 'lint']);
checked('WOS-00 verifier', 'npm', ['run', 'test:wos00-baseline']);
checked('Bootstrap scanner adversarial fixtures', 'node', ['scripts/scan-bootstrap.mjs', '--self-test']);
checked('Bootstrap security scan', 'npm', ['run', 'test:bootstrap-scan']);
checked('Retained safe test suite', 'npm', ['test'], { timeout: 20 * 60 * 1000, env: testEnv });

const defaultBuild = runAllowFailure('npm', ['run', 'build'], {
  timeout: 15 * 60 * 1000,
  env: {
    VITE_APP_MODE: '',
    VITE_ALLOW_TEST_FALLBACK: '',
    VITE_PRODUCT_NAME: '',
    VITE_PRODUCT_LOGO_URL: '',
    VITE_ORGANIZATION_NAME: '',
    VITE_SUPPORT_NAME: '',
    VITE_SUPPORT_EMAIL: '',
  },
});
if (defaultBuild.status !== 0) throw new Error(`Default build failed:\n${defaultBuild.output.slice(-12000)}`);
if (/%VITE_[A-Z0-9_]+%/.test(defaultBuild.output)) throw new Error('Default build emitted unresolved Vite placeholder output');
const defaultDist = await readFile(path.join(targetRoot, 'dist/index.html'), 'utf8');
if (/%VITE_[A-Z0-9_]+%/.test(defaultDist)) throw new Error('Default dist/index.html contains unresolved Vite placeholders');
if (!defaultDist.includes('<title>WorkOS</title>') || !defaultDist.includes('/workos-mark.svg')) {
  throw new Error('Default dist/index.html does not contain WorkOS identity defaults');
}
checks.push({ name: 'Default production build', status: 'PASS', output: 'No unresolved placeholders; WorkOS title and favicon present.' });

await rm(path.join(targetRoot, 'dist'), { recursive: true, force: true });
const configuredBuild = run('Configured branding build', 'npm', ['run', 'build'], {
  timeout: 15 * 60 * 1000,
  env: {
    VITE_APP_MODE: 'production',
    VITE_ALLOW_TEST_FALLBACK: 'false',
    VITE_PRODUCT_NAME: 'Configured WorkOS',
    VITE_PRODUCT_LOGO_URL: '/configured-workos.svg',
    VITE_ORGANIZATION_NAME: 'Configured organization',
    VITE_SUPPORT_NAME: 'Configured Support',
    VITE_SUPPORT_EMAIL: 'support@example.test',
  },
});
if (/%VITE_[A-Z0-9_]+%/.test(configuredBuild)) throw new Error('Configured build emitted unresolved Vite placeholder output');
const assetFiles = (await walk(path.join(targetRoot, 'dist/assets'))).filter(file => file.endsWith('.js'));
const assetText = (await Promise.all(assetFiles.map(file => readFile(file, 'utf8')))).join('\n');
if (!assetText.includes('Configured WorkOS') || !assetText.includes('/configured-workos.svg')) {
  throw new Error('Configured product name/logo were not embedded in the production bundle');
}
checks.push({ name: 'Configured branding build', status: 'PASS', output: 'Configured product name and logo embedded in production assets.' });

await rm(path.join(targetRoot, 'dist'), { recursive: true, force: true });
run('Git diff check', 'git', ['diff', '--check']);

await mkdir(path.join(targetRoot, path.dirname(EVIDENCE_PATH)), { recursive: true });
const digest = await resultDigest();
const versionsTable = [
  ['express', selectedVersions.express],
  ['react-router-dom', selectedVersions.reactRouterDom],
  ['vite', selectedVersions.vite],
].map(([name, version]) => `| ${name} | ${version} |`).join('\n');
const checksTable = checks.map(item => `| ${item.name} | ${item.status} | ${item.output.replaceAll('|', '\\|').replaceAll('\n', '<br>')} |`).join('\n');
const packageRows = beforeProduction.packages.map(item => `| ${item.name} | ${item.severity} | ${item.direct ? 'direct' : 'transitive'} | ${String(item.fixAvailable)} |`).join('\n');
const evidence = `# DOC-WOS-01-002 — Clean Runtime Closure\n\n## Authority\n\n- Workstream: WOS-01B\n- Existing Draft PR: #16\n- Exact parent: \`${EXPECTED_PARENT}\`\n- Result payload SHA-256: \`${digest}\`\n- Result digest excludes this self-referential evidence file, Git metadata, node_modules and dist.\n\n## Accepted input\n\nRead-only clean-runtime run \`33094613638\` proved disposable PostgreSQL fresh/replay/upgrade migrations, production fail-closed identity/seed behavior, production startup/health and disabled local production login. That external controller evidence is referenced, not relabelled as newly executed here.\n\n## Dependency closure\n\nBefore correction, both full and production-only audits reported ${beforeProduction.counts.total} advisories: ${beforeProduction.counts.low} low, ${beforeProduction.counts.moderate} moderate, ${beforeProduction.counts.high} high and ${beforeProduction.counts.critical} critical.\n\n| Package | Severity | Reachability | Fix available |\n|---|---|---|---|\n${packageRows}\n\nSelected direct compatible versions:\n\n| Package | Version |\n|---|---|\n${versionsTable}\n\nAfter correction, the production audit reports ${afterProduction.counts.total} advisories: ${afterProduction.counts.low} low, ${afterProduction.counts.moderate} moderate, ${afterProduction.counts.high} high and ${afterProduction.counts.critical} critical. No force upgrade, advisory suppression or test weakening was used.\n\n## Branding closure\n\n- Default HTML uses WorkOS title and \`/workos-mark.svg\` favicon with no unresolved \`%VITE_*%\` token.\n- Runtime bootstrap applies governed \`productConfig.productName\` and \`productConfig.logoUrl\`, preserving environment-based customization.\n- Both default and configured production builds passed; configured values were verified in the generated production assets.\n\n## Verification\n\n| Check | Result | Evidence |\n|---|---|---|\n${checksTable}\n\n## Frozen A–I disposition\n\n- **A:** canonical build and retained test path remain green.\n- **B:** production high/critical dependency findings are removed without auth or credential weakening.\n- **C/D/E:** no database, transaction, replay, idempotency or lifecycle code changed.\n- **F:** audit/build/test failures remain visible and fail publication.\n- **G:** no generated cache or unbounded fixture is committed.\n- **H:** explicit test fallback and production fail-closed behavior remain unchanged.\n- **I:** changed scope, audits, builds and tests are reproducible from the exact parent.\n\n## Changed scope\n\nExactly six paths are authorized: package manifest/lock, index identity defaults, runtime identity application, one retained identity test and this evidence file.\n\n## Limitations and rollback\n\nThis package does not deploy or call a real identity provider. Reset the Draft branch to \`${EXPECTED_PARENT}\` before merge to roll back; after merge use a reviewed revert or forward correction.\n`;
await writeFile(path.join(targetRoot, EVIDENCE_PATH), evidence);

run('Final product identity test', 'npm', ['run', 'test:product-identity']);
run('Final WOS-00 verifier', 'npm', ['run', 'test:wos00-baseline']);
run('Final bootstrap scanner', 'npm', ['run', 'test:bootstrap-scan']);
run('Final Git diff check', 'git', ['diff', '--check']);

const actualChanged = changedPaths();
if (JSON.stringify(actualChanged) !== JSON.stringify(changedPathsExpected)) {
  throw new Error(`Changed scope mismatch:\nexpected=${JSON.stringify(changedPathsExpected)}\nactual=${JSON.stringify(actualChanged)}`);
}

console.log(JSON.stringify({
  parent: EXPECTED_PARENT,
  resultDigest: digest,
  selectedVersions,
  beforeFull,
  beforeProduction,
  afterFull,
  afterProduction,
  changedPaths: actualChanged,
  checks: checks.map(({ name, status }) => ({ name, status })),
}, null, 2));
