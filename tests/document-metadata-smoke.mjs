import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync, rmSync} from 'node:fs';
import vm from 'node:vm';

const sourceDocument = readFileSync('index.html', 'utf8');
const inlineModuleMatch = sourceDocument.match(/<script type="module">\s*([\s\S]*?)<\/script>/);
assert.ok(inlineModuleMatch, 'index.html must retain the governed inline metadata module');
const metadataModule = inlineModuleMatch[1];

const build = environment => {
  rmSync('dist', {force: true, recursive: true});
  execFileSync('npm', ['run', 'build'], {
    env: {...process.env, ...environment},
    stdio: 'inherit',
  });
  const document = readFileSync('dist/index.html', 'utf8');
  const assets = readdirSync('dist/assets')
    .filter(name => name.endsWith('.js'))
    .sort()
    .map(name => readFileSync(`dist/assets/${name}`, 'utf8'))
    .join('\n');
  return {document, assets};
};

const resolveRuntimeMetadata = environment => {
  const favicon = {
    href: '/workos-mark.svg',
    setAttribute(name, value) {
      assert.equal(name, 'href');
      this.href = String(value);
    },
  };
  const document = {
    title: 'WorkOS',
    getElementById(id) {
      return id === 'workos-favicon' ? favicon : null;
    },
  };
  const executable = metadataModule
    .replaceAll(
      'import.meta.env.VITE_PRODUCT_NAME',
      JSON.stringify(environment.VITE_PRODUCT_NAME ?? ''),
    )
    .replaceAll(
      'import.meta.env.VITE_PRODUCT_LOGO_URL',
      JSON.stringify(environment.VITE_PRODUCT_LOGO_URL ?? ''),
    );
  vm.runInNewContext(executable, {document}, {timeout: 1000});
  return {title: document.title, favicon: favicon.href};
};

try {
  const defaultBuild = build({
    VITE_PRODUCT_NAME: '',
    VITE_PRODUCT_LOGO_URL: '',
  });
  assert.match(defaultBuild.document, /<title>WorkOS<\/title>/);
  assert.match(defaultBuild.document, /href="\/workos-mark\.svg"/);
  assert.doesNotMatch(defaultBuild.document, /%VITE_[A-Z0-9_]+%/);
  assert.doesNotMatch(defaultBuild.assets, /%VITE_[A-Z0-9_]+%/);
  assert.deepEqual(resolveRuntimeMetadata({}), {
    title: 'WorkOS',
    favicon: '/workos-mark.svg',
  });

  const configuredEnvironment = {
    VITE_PRODUCT_NAME: 'Synthetic Product',
    VITE_PRODUCT_LOGO_URL: '/synthetic-mark.svg',
  };
  const configuredBuild = build(configuredEnvironment);
  assert.match(configuredBuild.document, /<title>WorkOS<\/title>/);
  assert.match(configuredBuild.document, /href="\/workos-mark\.svg"/);
  assert.doesNotMatch(configuredBuild.document, /%VITE_[A-Z0-9_]+%/);
  assert.doesNotMatch(configuredBuild.assets, /%VITE_[A-Z0-9_]+%/);
  assert.match(configuredBuild.assets, /Synthetic Product/);
  assert.match(configuredBuild.assets, /\/synthetic-mark\.svg/);
  assert.deepEqual(resolveRuntimeMetadata(configuredEnvironment), {
    title: 'Synthetic Product',
    favicon: '/synthetic-mark.svg',
  });
} finally {
  rmSync('dist', {force: true, recursive: true});
}

console.log(JSON.stringify({
  status: 'passed',
  modes: ['default-neutral-shell', 'configured-runtime'],
  configuredValuesEmbedded: true,
}, null, 2));
