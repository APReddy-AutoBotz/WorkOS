import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

const sourceDocument = readFileSync('index.html', 'utf8');
assert.doesNotMatch(sourceDocument, /import\.meta\.env\.VITE_PRODUCT_(?:NAME|LOGO_URL)/);
assert.match(sourceDocument, /<title>WorkOS<\/title>/);
assert.match(sourceDocument, /id="workos-favicon"[\s\S]*href="\/workos-mark\.svg"/);

const withoutBrandEnvironment = () => {
  const environment = {...process.env};
  delete environment.VITE_PRODUCT_NAME;
  delete environment.VITE_PRODUCT_LOGO_URL;
  return environment;
};

const walkText = root => {
  const result = [];
  for (const name of readdirSync(root).sort()) {
    const file = path.join(root, name);
    if (statSync(file).isDirectory()) result.push(walkText(file));
    else result.push(readFileSync(file, 'utf8'));
  }
  return result.join('\n');
};

const build = environment => {
  rmSync('dist', {force: true, recursive: true});
  execFileSync(process.execPath, [viteCli, 'build'], {
    env: environment,
    stdio: 'inherit',
  });
  return {
    document: readFileSync('dist/index.html', 'utf8'),
    output: walkText('dist'),
  };
};

const assertDocumentMetadata = (document, title, logoUrl) => {
  assert.match(document, new RegExp(`<title>${title}<\\/title>`));
  assert.match(
    document,
    new RegExp(`id="workos-favicon"[\\s\\S]*href="${logoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
  );
  assert.doesNotMatch(document, /%VITE_[A-Z0-9_]+%/);
  assert.doesNotMatch(document, /import\.meta\.env\.VITE_PRODUCT_(?:NAME|LOGO_URL)/);
};

try {
  const defaultBuild = build(withoutBrandEnvironment());
  assertDocumentMetadata(defaultBuild.document, 'WorkOS', '/workos-mark.svg');
  assert.doesNotMatch(defaultBuild.output, /%VITE_[A-Z0-9_]+%/);

  const configuredEnvironment = withoutBrandEnvironment();
  configuredEnvironment.VITE_PRODUCT_NAME = 'Synthetic Product';
  configuredEnvironment.VITE_PRODUCT_LOGO_URL = '/synthetic-mark.svg';
  const configuredBuild = build(configuredEnvironment);
  assertDocumentMetadata(configuredBuild.document, 'Synthetic Product', '/synthetic-mark.svg');
  assert.doesNotMatch(configuredBuild.output, /%VITE_[A-Z0-9_]+%/);
  assert.match(configuredBuild.output, /Synthetic Product/);
  assert.match(configuredBuild.output, /\/synthetic-mark\.svg/);
} finally {
  rmSync('dist', {force: true, recursive: true});
}

console.log(JSON.stringify({
  status: 'passed',
  modes: ['default-neutral-build', 'configured-white-label-build'],
  emittedDocumentMetadataVerified: true,
}, null, 2));
