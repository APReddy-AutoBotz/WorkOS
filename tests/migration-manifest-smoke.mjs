import assert from 'node:assert/strict';
import {getMigrationManifest, getMigrationStatus} from '../server/migrate.mjs';

const manifest = await getMigrationManifest();
assert.equal(manifest[0].id, '005_auth_lifecycle');
assert.equal(manifest[0].file, 'schema.sql');
const migrationIds = manifest.slice(1).map(item => item.id);
assert.deepEqual(migrationIds, [...migrationIds].sort(), 'migration order must be deterministic');
assert.equal(new Set(manifest.map(item => item.id)).size, manifest.length, 'migration IDs must be unique');
assert(manifest.slice(1).every(item => item.file.endsWith('.sql') && item.baseline === false));

const appliedRows = manifest.slice(0, -1).map(item => ({id: item.id, checksum: null}));
const partial = await getMigrationStatus({query: async () => ({rows: appliedRows})});
assert.equal(partial.isCurrent, false);
assert.deepEqual(partial.appliedIds, appliedRows.map(row => row.id));
assert.deepEqual(partial.pendingIds, [manifest.at(-1).id]);
assert.deepEqual(partial.legacyUnverifiedIds, appliedRows.map(row => row.id));
assert.equal(partial.currentVersion, manifest.at(-2).id);

const gap = await getMigrationStatus({query: async () => ({rows: [
  {id: manifest[0].id, checksum: 'a'.repeat(64)},
  {id: manifest.at(-1).id, checksum: 'b'.repeat(64)},
]})});
assert.equal(gap.currentVersion, manifest[0].id, 'migration level must stop at the first missing entry');
assert.equal(gap.isCurrent, false);

const current = await getMigrationStatus({query: async () => ({rows: manifest.map(item => ({id: item.id, checksum: 'a'.repeat(64)}))})});
assert.equal(current.isCurrent, true);
assert.deepEqual(current.pendingIds, []);
assert.equal(current.currentVersion, manifest.at(-1).id);

const unsupported = await getMigrationStatus({query: async () => ({rows: [
  ...manifest.map(item => ({id: item.id, checksum: 'a'.repeat(64)})),
  {id: '999_future_release', checksum: 'b'.repeat(64)},
]})});
assert.equal(unsupported.isCurrent, false, 'unknown applied migrations must block readiness for an older application');
assert.deepEqual(unsupported.unknownIds, ['999_future_release']);

console.log(`Migration manifest smoke tests passed (${manifest.length} ordered entries).`);
