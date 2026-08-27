import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const selfTest = process.argv.includes('--self-test');
const root = path.resolve(selfTest ? process.cwd() : (process.argv[2] || process.cwd()));
const scanRoots = ['src', 'server', 'templates', 'public', 'tests'];
const rootFiles = [
  '.env.example',
  '.gitignore',
  'index.html',
  'metadata.json',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'docs/03-specifications/WOS01A_RETAINED_REQUIREMENTS.md',
];
const files = [];

const exists = async (file) => access(file).then(() => true).catch(() => false);
const walk = async (dir) => {
  if (!(await exists(dir))) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile()) files.push(file);
  }
};
for (const item of scanRoots) await walk(path.join(root, item));
for (const item of rootFiles) {
  const file = path.join(root, item);
  if (await exists(file)) files.push(file);
}

const forbiddenPathRules = [
  ['reference-company path', /boundaryless/i],
  ['RUT path token', /(^|[._/\-])rut([._/\-]|$)/i],
  ['old logo or wordmark path', /(?:boundaryless|rut|legacy|old)[-_]?(?:logo|mark|wordmark)|workos-(?:logo|wordmark)(?:-mini)?/i],
  ['credential-bearing filename', /(^|[._/\-])(?:credentials?|secrets?|private[-_]?key)([._/\-]|$)/i],
  ['private key extension', /\.(?:pem|p12|pfx|key)$/i],
];
const contentRules = [
  ['reference brand/domain', /Boundaryless|boundaryless\.com/i],
  ['RUT runtime token', /(^|[^A-Za-z0-9])rut(?=$|[^A-Za-z0-9])/i],
  ['old logo/wordmark reference', /boundaryless[-_ ]?(?:logo|mark|wordmark)|workos-(?:logo|wordmark)(?:-mini)?/i],
  ['company-only access copy', /Authorized Internal Access|Internal workforce planning workspace|Boundaryless-WorkOS Workforce Operations Core/i],
  ['shared demo password', /demo123/i],
  ['private key', /-----BEGIN (?:PGP PRIVATE KEY BLOCK|(?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY)-----/i],
  ['GitHub token', /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/],
  ['OpenAI-style secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
];
// Deliberately exclude a bare `key`: it is a ubiquitous program/schema property. Compound
// credential names remain fail-closed, as do bare password/passphrase/secret/token fields.
const credentialName = String.raw`(?:password|passphrase|credential|secret|token|(?:api|access|client|private|signing|encryption)[_-]?key|[A-Za-z_$][\w$]*(?:Password|Passphrase|Credential|Secret|Token|ApiKey|AccessKey|ClientKey|PrivateKey|SigningKey|EncryptionKey)|[A-Za-z_$][\w$]*(?:_password|_passphrase|_credential|_secret|_token|_(?:api|access|client|private|signing|encryption)_?key))`;
const credentialAssignment = new RegExp(
  String.raw`(?:["']\s*)?\b(${credentialName})\b\s*(?:["']\s*)?[:=]\s*(['"\x60])([^'"\x60\r\n]+)\2`,
  'gi',
);
const unquotedConfigCredential = new RegExp(
  String.raw`^[ \t]*(?:["'][ \t]*)?(${credentialName})(?:[ \t]*["'])?[ \t]*[:=][ \t]*([^\s#'"\x60][^\r\n#]*?)[ \t]*(?:#.*)?$`,
  'gim',
);
const TEST_ONLY_PASSWORD = 'workos-test-only';
const explicitPlaceholder = /^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|(?:your|replace[-_ ]?with|example|placeholder)[-_ ].+)$/i;
const isSafeCredentialDeclaration = (value, relative) => {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (relative.startsWith('tests/') && trimmed === TEST_ONLY_PASSWORD) return true;
  if (explicitPlaceholder.test(trimmed)) return true;
  // Schema/UI declarations frequently map a field to its type or display label. They are not
  // credential values; predictable operational values such as demo123 remain prohibited.
  const normalizedValue = trimmed.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ['string', 'text', 'field'].includes(normalizedValue);
};
const runtimeHosts = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'teams.microsoft.com',
  'outlook.office.com',
  'example.test',
  'example.invalid',
]);
const isAllowedHost = (hostname) =>
  runtimeHosts.has(hostname) || hostname.endsWith('.example.test') || hostname.endsWith('.example.invalid');
const packageProvenanceHosts = new Set([
  'registry.npmjs.org',
  'www.npmjs.com',
  'npmjs.com',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'opencollective.com',
  'funding.communitybridge.org',
  'tidelift.com',
  'dotenvx.com',
  'www.patreon.com',
  'feross.org',
]);
const isKnownNonRuntimeUrl = (relative, parsed) =>
  (['package.json', 'package-lock.json'].includes(relative) && packageProvenanceHosts.has(parsed.hostname.toLowerCase())) ||
  (relative.endsWith('.svg') && parsed.href === 'http://www.w3.org/2000/svg');
const normalizeLocalTemplateUrl = (rawUrl) => rawUrl.replace(
  /^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])):\$\{[^}]+\}/i,
  '$1:0',
);

const failures = [];
for (const file of [...new Set(files)].sort()) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  for (const [name, pattern] of forbiddenPathRules) {
    if (pattern.test(relative)) failures.push(`${name}: ${relative}`);
  }

  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  for (const [name, pattern] of contentRules) {
    if (pattern.test(text)) failures.push(`${name}: ${relative}`);
  }

  for (const match of text.matchAll(credentialAssignment)) {
    if (!isSafeCredentialDeclaration(match[3], relative)) failures.push(`credential assignment (${match[1]}): ${relative}`);
  }
  if (/(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.ya?ml)$/i.test(relative)) {
    for (const match of text.matchAll(unquotedConfigCredential)) {
      const value = match[2].trim();
      if (!isSafeCredentialDeclaration(value, relative)) failures.push(`unquoted config credential (${match[1]}): ${relative}`);
    }
  }
  if (/^(?:src|server|templates)\//.test(relative) &&
      relative !== 'src/config/productConfig.ts' && /\bWorkOS\b/.test(text)) {
    failures.push(`hardcoded runtime product brand: ${relative}`);
  }

  // Retained tests may assert URL-shaped regular expressions. Remove only syntactically
  // delimited regex literals before decoding serialized string slashes; runtime strings,
  // templates, HTML/CSS URLs and configuration values remain subject to hostname policy.
  const urlSourceText = relative.startsWith('tests/')
    ? text.replace(/\/https?:\\\/\\\/[^/\r\n]+\/[dgimsuvy]*/g, '')
    : text;
  const urlScanText = urlSourceText.replaceAll('\\/', '/').replace(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\$\{[^}\r\n]+\}/gi,
    rawUrl => normalizeLocalTemplateUrl(rawUrl),
  );
  const urlCandidates = [
    ...urlScanText.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/gi),
    ...urlScanText.matchAll(/[='"`(]\s*\/\/([A-Za-z0-9.\-\[\]:]+)(?:\/[^\s'"<>`]*)?/g),
  ];
  for (const match of urlCandidates) {
    const matchedUrl = match[0].replace(/^[='"`(\s]+/, '');
    const rawUrl = normalizeLocalTemplateUrl(matchedUrl.replace(/[),.;]+$/, ''));
    try {
      const parsed = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl);
      if (parsed.username || parsed.password) {
        failures.push(`credential-bearing URL: ${relative}`);
        continue;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (!isAllowedHost(parsed.hostname.toLowerCase()) && !isKnownNonRuntimeUrl(relative, parsed)) {
        failures.push(`non-placeholder remote URL (${parsed.hostname}): ${relative}`);
      }
    } catch {
      failures.push(`unparseable remote URL: ${relative}`);
    }
  }
}

if (failures.length) {
  throw new Error(`Bootstrap scan failed (${failures.length} finding(s)):\n${[...new Set(failures)].join('\n')}`);
}
console.log(JSON.stringify({ status: 'passed', filesScanned: new Set(files).size, roots: [...scanRoots, ...rootFiles] }, null, 2));

if (selfTest) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'wos01a-scan-'));
  const scanner = new URL(import.meta.url).pathname;
  const runFixture = async (name, contents, shouldPass) => {
    const fixture = path.join(fixtureRoot, name);
    for (const dir of scanRoots) await mkdir(path.join(fixture, dir), { recursive: true });
    for (const [relative, text] of Object.entries(contents)) {
      const file = path.join(fixture, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    const result = spawnSync(process.execPath, [scanner, fixture], { encoding: 'utf8' });
    if ((result.status === 0) !== shouldPass) {
      throw new Error(`Adversarial fixture ${name} unexpectedly ${result.status === 0 ? 'passed' : 'failed'}:\n${result.stdout}${result.stderr}`);
    }
  };
  try {
    await runFixture('safe-identifiers', { 'src/safe.ts': `const key = schemaKey; const token = getToken(); const password = input.password;\nconst initialPassword = makePassword(); const sortKey = (row) => row.id; const dataKey: keyof Row = 'id'; const permissionKey = permission.key;\n`, '.env.example': 'PASSWORD=\nAPI_TOKEN=<replace-with-local-token>\nCLIENT_SECRET=${LOCAL_CLIENT_SECRET}\n' }, true);
    await runFixture('safe-regex', { 'tests/regex.mjs': String.raw`const graphScope = /https:\/\/graph\.microsoft\.com\/\.default/;\n` }, true);
    await runFixture('quoted-js-credential', { 'src/bad.ts': "const initialPassword = 'CompanyPass2026!';\n" }, false);
    await runFixture('template-js-credential', { 'server/bad.mjs': 'const refreshToken = `CompanyToken2026!`;\n' }, false);
    await runFixture('json-credential', { 'templates/import/bad.json': '{"apiKey":"CompanyKey2026!"}\n' }, false);
    await runFixture('env-credential', { '.env.example': 'API_TOKEN=CompanyToken2026!\n' }, false);
    await runFixture('yaml-credential', { 'server/config.yml': 'temporary_password: CompanyPass2026!\n' }, false);
    await runFixture('credential-uri', { 'src/bad.ts': "const endpoint = 'https://user:pass@example.test/api';\n" }, false);
    await runFixture('runtime-url', { 'src/bad.ts': "const endpoint = 'https://prod.customer.example.com/api';\n" }, false);
    await runFixture('escaped-runtime-url', { 'src/bad.ts': String.raw`const endpoint = 'https:\/\/prod.customer.example.com/api';\n` }, false);
    await runFixture('protocol-relative-url', { 'src/bad.ts': "const endpoint = '//prod.customer.example.com/api';\n" }, false);
    await runFixture('hostname-lookalike', { 'src/bad.ts': "const endpoint = 'https://graph.microsoft.com.evil.example/api';\n" }, false);
    await runFixture('runtime-provenance', { 'src/bad.ts': "const endpoint = 'https://github.com/customer/private-api';\n" }, false);
    await runFixture('private-key', { 'tests/key.txt': '-----BEGIN ENCRYPTED PRIVATE KEY-----\nnot-a-real-key\n' }, false);
    await runFixture('pgp-private-key', { 'src/key.txt': '-----BEGIN PGP PRIVATE KEY BLOCK-----\nnot-a-real-key\n' }, false);
    await runFixture('forbidden-path', { 'src/rut_session.ts': 'export const value = 1;\n' }, false);
    await runFixture('forbidden-brand', { 'src/bad.ts': "export const label = 'Boundaryless';\n" }, false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: 'passed', check: 'adversarial-fixtures' }));
}
