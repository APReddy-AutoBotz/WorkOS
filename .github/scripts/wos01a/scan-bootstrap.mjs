import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
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
];
const files = [];

const exists = async (file) => access(file).then(() => true).catch(() => false);
const walk = async (dir) => {
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
  ['RUT runtime token', /\bRUT\b/],
  ['old logo/wordmark reference', /boundaryless[-_ ]?(?:logo|mark|wordmark)|workos-(?:logo|wordmark)(?:-mini)?/i],
  ['company-only access copy', /Authorized Internal Access|Internal workforce planning workspace|Boundaryless-WorkOS Workforce Operations Core/i],
  ['shared demo password', /demo123/i],
  ['private key', /-----BEGIN (?:(?:RSA|OPENSSH|EC|DSA) |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub token', /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/],
  ['OpenAI-style secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
];
const allowedHosts = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'teams.microsoft.com',
  'outlook.office.com',
  'registry.npmjs.org',
  'www.npmjs.com',
  'npmjs.com',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'opencollective.com',
  'funding.communitybridge.org',
  'tidelift.com',
  'example.test',
  'example.invalid',
]);
const isAllowedHost = (hostname) =>
  allowedHosts.has(hostname) || hostname.endsWith('.example.test') || hostname.endsWith('.example.invalid');
const packageProvenanceHosts = new Set(['dotenvx.com', 'www.patreon.com', 'feross.org']);
const isKnownNonRuntimeUrl = (relative, parsed) =>
  (relative === 'package-lock.json' && packageProvenanceHosts.has(parsed.hostname.toLowerCase())) ||
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

  for (const match of text.matchAll(/https?:\/\/[^\s'"<>`]+/gi)) {
    const rawUrl = normalizeLocalTemplateUrl(match[0].replace(/[),.;]+$/, ''));
    try {
      const parsed = new URL(rawUrl);
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
