import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

function build(environment = {}) {
  execFileSync('npm', ['run', 'build'], {
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  return readFileSync('dist/index.html', 'utf8');
}

try {
  const defaultDocument = build({
    VITE_PRODUCT_NAME: '',
    VITE_PRODUCT_LOGO_URL: '',
  });
  assert.match(defaultDocument, /<title>WorkOS<\/title>/);
  assert.match(defaultDocument, /href="\/workos-mark\.svg"/);
  assert.doesNotMatch(defaultDocument, /%VITE_[A-Z0-9_]+%/);

  const configuredDocument = build({
    VITE_PRODUCT_NAME: 'Synthetic Product',
    VITE_PRODUCT_LOGO_URL: '/synthetic-mark.svg',
  });
  assert.match(configuredDocument, /Synthetic Product/);
  assert.match(configuredDocument, /\/synthetic-mark\.svg/);
  assert.doesNotMatch(configuredDocument, /%VITE_[A-Z0-9_]+%/);
} finally {
  rmSync('dist', { force: true, recursive: true });
}

console.log(JSON.stringify({ status: 'passed', modes: ['default', 'configured'] }, null, 2));
