import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [dockerfile,compose,ci]=await Promise.all([
  read('Dockerfile'),read('compose.yaml'),read('.github/workflows/workos-ci.yml')
]);
const stages=dockerfile.split(/\r?\n/).filter(line=>/^FROM\s/i.test(line));
assert.equal(stages.length,3);
assert.match(stages[0],/^FROM node:[^\s@]+@sha256:[a-f0-9]{64} AS base$/);
assert.deepEqual(stages.slice(1),['FROM base AS build','FROM base AS runtime']);
function databaseReference(config) {
  const matches=[...config.matchAll(/^\s*image:\s*(postgres:[^\s#]+)/gm)];
  assert.equal(matches.length,1,'Expected one PostgreSQL image');
  const reference=matches[0][1];
  assert.match(reference,/^postgres:[^\s@]+@sha256:[a-f0-9]{64}$/);
  return reference;
}
assert.equal(databaseReference(compose),databaseReference(ci),'CI and buyer PostgreSQL images must match');
console.log('Verified shared build/runtime base and identical pinned PostgreSQL deployment and CI inputs.');
