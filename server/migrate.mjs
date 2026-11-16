import 'dotenv/config';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRuntimeEnvironment} from './environment.mjs';
import {formatSafeMigrationFailure, getMigrationManifest, getMigrationStatus, runMigrations} from './migration-runner.mjs';

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  try {
    const environment = validateRuntimeEnvironment(process.env, {purpose: 'migration'});
    const result = await runMigrations({databaseUrl: environment.databaseUrl, sslMode: environment.pgSslMode, sslRootCert: environment.pgSslRootCert});
    if (result.applied.length === 0) console.log('Database schema is current.');
  } catch (error) {
    console.error(`Migration failed: ${formatSafeMigrationFailure(error)}`);
    process.exitCode = 1;
  }
}

export {getMigrationManifest, getMigrationStatus, runMigrations};
