import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {validateWorkingCalendar} from '../server/working-calendars.mjs';

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const atLeast = (actual, minimum) => {
  assert.match(actual, /^\d+\.\d+\.\d+$/, 'Only stable resolved versions are accepted');
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return true;
};

test('lockfile retains patched versions for every affected package instance', () => {
  const floors = {
    'body-parser': '1.20.9', 'proxy-addr': '2.0.8', qs: '6.16.2',
    'source-map-js': '1.2.2', vite: '6.4.6', zod: '4.6.6',
  };
  for (const [name, floor] of Object.entries(floors)) {
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
    assert.ok(entries.length, `Missing ${name}`);
    for (const [path, value] of entries) {
      // A newer major is not automatically safe: other release families have
      // different advisory intervals and need a separate compatibility review.
      assert.equal(value.version.split('.')[0], floor.split('.')[0], `${path} changed its reviewed major`);
      assert.ok(atLeast(value.version, floor), `${path} must be >= ${floor}`);
    }
  }
  // GHSA-g7r4-m6w7-qqqr affects >=0.27.3 through 0.28.0. Vite 6's
  // separate 0.25.x copy is outside that interval; do not force its major.
  const esbuilds = Object.entries(lock.packages).filter(([path]) => path.endsWith('/esbuild'));
  assert.ok(esbuilds.length);
  for (const [path, value] of esbuilds) {
    assert.ok(!atLeast(value.version, '0.27.3') || atLeast(value.version, '0.28.1'), `${path} is in the vulnerable interval`);
  }
});

test('proxy trust cannot turn a short IPv4-mapped IPv6 prefix into trust-all', () => {
  const proxyaddr = require('proxy-addr');
  const short = proxyaddr.compile('::ffff:10.0.0.0/8');
  assert.equal(short('203.0.113.10', 0), false);
  assert.equal(proxyaddr.compile('::/1')('203.0.113.10', 0), false);
  const mapped = proxyaddr.compile('::ffff:10.0.0.0/104');
  assert.equal(mapped('10.20.30.40', 0), true);
  assert.equal(mapped('203.0.113.10', 0), false);
});

test('updated Zod preserves actual working-calendar validation boundaries', () => {
  const valid = {code:'TEST', name:'Synthetic calendar', timezone:'UTC', workingDays:[1,2,3,4,5], hoursPerDay:8, effectiveFrom:'2026-11-11', applicability:{type:'legal_entity'}};
  assert.equal(validateWorkingCalendar(valid).success, true);
  assert.equal(validateWorkingCalendar({...valid, workingDays:Array(256).fill(1)}).success, false);
  assert.equal(validateWorkingCalendar({...valid, workingDays:[1,1]}).success, false);
  assert.equal(validateWorkingCalendar({...valid, applicability:{type:'legal_entity', organizationId:'caller-spoof'}}).success, false);
  assert.equal(validateWorkingCalendar({...valid, applicability:{type:'country', countryCode:'bad'}}).success, false);
});

test('compressed-body late errors do not terminate the Express process', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./support/dependency-http-compatibility.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding:'utf8', timeout:15000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `Child failed: ${child.stderr}\n${child.stdout}`);
  assert.match(child.stdout, /compressed-body compatibility passed/);
});
