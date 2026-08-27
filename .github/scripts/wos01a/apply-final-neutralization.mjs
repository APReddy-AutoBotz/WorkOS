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
  "  .replace('Shared UAT credentials are available only for testing and must be replaced by named production accounts before go-live.', 'Test identities are available only in explicit test mode; production requires named accounts and governed identity configuration.')\n  .replace('UAT seeded users use the configured demo password. Production must use named accounts and server-side password policies.', 'Test accounts require an explicitly supplied test password. Production uses named accounts and governed server-side password policy.')\n  .replace('UAT account shortcuts', 'Test account shortcuts')\n  // Neutralize every presentation of the historical shared password rather than\n  // depending on surrounding UI punctuation. Shortcuts use the entered password.\n  .replaceAll('demo123', 'password required')\n  .replace('multi-project demo', 'multi-project test account')\n  .replaceAll('Country Director mappings', '{productConfig.terminology.regionalOwner} mappings');\nif (/demo123|Boundaryless|boundaryless\\.com/.test(loginText)) throw new Error('Unsafe or reference-company login copy remains');\nawait writeFile(loginPage, loginText);",
  'login neutralization',
);

replaceExactlyOnce(
  "if (/demo123|rut_session/.test(serverText)) throw new Error('Unsafe password/session fallback remains in server/index.mjs');\nawait writeFile(serverIndex, serverText);\n\nconst packageFile = path.join(targetRoot, 'package.json');",
  "if (/demo123|rut_session/.test(serverText)) throw new Error('Unsafe password/session fallback remains in server/index.mjs');\nawait writeFile(serverIndex, serverText);\n\n// This synthetic credential is deterministic and confined to retained tests plus\n// their in-memory test storage; runtime UI/server/config never receive plaintext.\nconst TEST_ONLY_PASSWORD = 'workos-test-only';\nconst TEST_ONLY_PASSWORD_HASH = 'sha256:38094400ab24889690788361033f7727fe69ec3e18b4da756ee593d5dcba2c13';\nconst storageFile = path.join(targetRoot, 'src/services/storage.ts');\nlet storageText = await readFile(storageFile, 'utf8');\nconst neutralLegacyBlock = 'const LEGACY_DEMO_PERSON_NAMES = new Set<string>();';\nstorageText = storageText.replace(\n  /const LEGACY_DEMO_PERSON_NAMES = new Set\\(\\[[\\s\\S]*?\\]\\);/,\n  neutralLegacyBlock,\n);\nstorageText = storageText.replace(\n  /const DEMO_PASSWORD_HASH = 'sha256:[a-f0-9]{64}';/,\n  `const DEMO_PASSWORD_HASH = '${TEST_ONLY_PASSWORD_HASH}';`,\n);\nif (!storageText.includes(neutralLegacyBlock)) throw new Error('Legacy named-demo person block was not neutralized');\nif (!storageText.includes(TEST_ONLY_PASSWORD_HASH)) throw new Error('Test-only password hash was not neutralized');\nstorageText = storageText\n  .replaceAll(\"sessionStorage.removeItem('rut_session')\", \"sessionStorage.removeItem('workos_session')\")\n  .replaceAll('boundaryless.demo', 'example.test');\nawait writeFile(storageFile, storageText);\n\nconst demoDataFile = path.join(targetRoot, 'src/services/demoData.ts');\nlet demoDataText = await readFile(demoDataFile, 'utf8');\ndemoDataText = demoDataText.replaceAll('boundaryless.demo', 'example.test');\nawait writeFile(demoDataFile, demoDataText);\n\nfor (const testPath of selectedTestFiles) {\n  const testFile = path.join(targetRoot, testPath);\n  const testText = await readFile(testFile, 'utf8');\n  const neutralTestText = testText.replaceAll('demo123', TEST_ONLY_PASSWORD);\n  if (/demo123/i.test(neutralTestText)) throw new Error(`Shared password remains in retained test: ${testPath}`);\n  await writeFile(testFile, neutralTestText);\n}\n\nconst credentialFamilyPaths = [\n  loginPage, storageFile, demoDataFile, authService, serverIndex,\n  ...selectedTestFiles.map(testPath => path.join(targetRoot, testPath)),\n];\nfor (const credentialPath of credentialFamilyPaths) {\n  const credentialText = await readFile(credentialPath, 'utf8');\n  const relativeCredentialPath = rel(targetRoot, credentialPath);\n  if (/demo123/i.test(credentialText)) {\n    throw new Error(`Shared password survived credential convergence: ${relativeCredentialPath}`);\n  }\n  const normalizedCredentialPath = path.posix.normalize(relativeCredentialPath.replaceAll('\\\\', '/'));\n  const retainedTestCredentialPath = normalizedCredentialPath === 'tests' || normalizedCredentialPath.startsWith('tests/');\n  if (!retainedTestCredentialPath && credentialText.includes(TEST_ONLY_PASSWORD)) {\n    throw new Error(`Test-only plaintext escaped retained tests: ${relativeCredentialPath}`);\n  }\n}\n\nconst packageFile = path.join(targetRoot, 'package.json');",
  'legacy personal-data and test-credential neutralization',
);

replaceExactlyOnce(
  "    .replaceAll('Boundaryless', 'Your organization')\n    .replaceAll('boundaryless.com', 'example.test')\n    .replaceAll('boundaryless', 'your-organization')",
  "    .replaceAll('boundaryless.demo', 'example.test')\n    .replaceAll('Boundaryless', 'Your organization')\n    .replaceAll('boundaryless.com', 'example.test')\n    .replaceAll('boundaryless', 'your-organization')",
  'demo-domain neutralization',
);

const whitespaceNormalizationBlock = [
  "const NORMALIZABLE_TEXT_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.css', '.svg', '.xml']);",
  "const normalizeTextWhitespace = (text) => {",
  "  if (text.length === 0) return text;",
  "  const lf = text.replace(/\\r\\n?/g, '\\n');",
  "  const body = lf",
  "    .split('\\n')",
  "    .map(line => line.replace(/[ \\t]+$/g, ''))",
  "    .join('\\n')",
  "    .replace(/\\n+$/g, '');",
  "  return body ? `${body}\\n` : '';",
  "};",
  "",
  "const assertWhitespaceNormalizer = () => {",
  "  const normalized = normalizeTextWhitespace('alpha  \\r\\nbeta\\t\\r\\n\\r\\n');",
  "  if (normalized !== 'alpha\\nbeta\\n') throw new Error(`Whitespace normalizer mismatch: ${JSON.stringify(normalized)}`);",
  "  if (normalizeTextWhitespace(normalized) !== normalized) throw new Error('Whitespace normalizer is not idempotent');",
  "  if (normalizeTextWhitespace('alpha  beta\\n') !== 'alpha  beta\\n') throw new Error('Whitespace normalizer changed interior spaces');",
  "};",
  "",
  "const normalizeManagedTextWhitespace = async () => {",
  "  const candidates = new Set(selectedRootFiles);",
  "  for (const sourcePath of selected) candidates.add(sourceToTargetPath(sourcePath));",
  "  candidates.add(retainedRequirementsTarget);",
  "  candidates.add('scripts/scan-bootstrap.mjs');",
  "  candidates.add('scripts/verify-baseline.mjs');",
  "  for (const root of ['src', 'server', 'templates', 'tests', 'public', 'scripts']) {",
  "    for (const file of await walk(path.join(targetRoot, root))) candidates.add(rel(targetRoot, file));",
  "  }",
  "",
  "  let changedFiles = 0;",
  "  let strippedLines = 0;",
  "  for (const relative of [...candidates].sort()) {",
  "    const file = path.join(targetRoot, relative);",
  "    if (!(await exists(file))) continue;",
  "    const extension = path.extname(relative).toLowerCase();",
  "    const normalizable = NORMALIZABLE_TEXT_EXTENSIONS.has(extension) || path.basename(relative) === '.gitignore';",
  "    if (!normalizable) continue;",
  "    const before = await readFile(file, 'utf8');",
  "    const lfBefore = before.replace(/\\r\\n?/g, '\\n');",
  "    const trailingLineCount = lfBefore.split('\\n').filter(line => /[ \\t]+$/.test(line)).length;",
  "    const after = normalizeTextWhitespace(before);",
  "    if (after === before) continue;",
  "    await writeFile(file, after);",
  "    changedFiles += 1;",
  "    strippedLines += trailingLineCount;",
  "  }",
  "  return { changedFiles, strippedLines };",
  "};",
  "",
  "assertWhitespaceNormalizer();",
  "const whitespaceNormalization = await normalizeManagedTextWhitespace();",
  "",
  "const runResults = [];",
  "runResults.push({",
  "  name: 'Deterministic text whitespace normalization',",
  "  status: 'PASS',",
  "  output: `Normalized ${whitespaceNormalization.changedFiles} files and stripped trailing whitespace from ${whitespaceNormalization.strippedLines} lines.`,",
  "});",
].join('\n');

replaceExactlyOnce(
  'const runResults = [];',
  whitespaceNormalizationBlock,
  'managed text whitespace normalization',
);

const stagedDiffCheckBlock = [
  "const diffCheckDirectory = await mkdtemp(path.join(tmpdir(), 'wos01a-diff-check-'));",
  "try {",
  "  const diffCheckEnvironment = { GIT_INDEX_FILE: path.join(diffCheckDirectory, 'index') };",
  "  execFileSync('git', ['read-tree', 'HEAD'], {",
  "    cwd: targetRoot,",
  "    env: { ...process.env, ...diffCheckEnvironment },",
  "  });",
  "  execFileSync('git', ['add', '-A'], {",
  "    cwd: targetRoot,",
  "    env: { ...process.env, ...diffCheckEnvironment },",
  "  });",
  "  runCheck('Git diff check', 'git', ['diff', '--cached', '--check'], { env: diffCheckEnvironment });",
  "} finally {",
  "  await rm(diffCheckDirectory, { recursive: true, force: true });",
  "}",
].join('\n');

replaceExactlyOnce(
  "runCheck('Git diff check', 'git', ['diff', '--check']);",
  stagedDiffCheckBlock,
  'full staged-tree diff check',
);

await writeFile(publisher, source);
execFileSync(process.execPath, ['--check', publisher], { stdio: 'inherit' });
console.log(`Applied bounded final neutralization patch to ${publisher}`);
