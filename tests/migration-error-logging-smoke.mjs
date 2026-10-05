import assert from 'node:assert/strict';
import {formatSafeMigrationFailure} from '../server/migration-runner.mjs';

const databaseFailure = new Error('duplicate key value; DETAIL: Key (email)=(private.user@example.test) already exists.');
databaseFailure.code = '23505';

const migrationFailure = new Error('Migration 023_profile_index failed.');
migrationFailure.code = 'MIGRATION_FAILED';
migrationFailure.cause = databaseFailure;

const unknownEntryFailure = new Error('Migration ledger contains unsupported migration entries.');
unknownEntryFailure.code = 'UNKNOWN_MIGRATION_LEDGER_ENTRY';
unknownEntryFailure.entryCount = 1;

const output = [
  formatSafeMigrationFailure(migrationFailure),
  formatSafeMigrationFailure(databaseFailure),
  formatSafeMigrationFailure(unknownEntryFailure),
].join('\n');

assert.match(output, /Migration 023_profile_index failed\./);
assert.match(output, /database or migration failure \(23505\)/);
assert.match(output, /unsupported migration entries/);
assert.equal(output.includes('private.user@example.test'), false, 'database error details must not reach logs');

console.log('Migration error logging smoke tests passed.');
