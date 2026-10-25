import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commercialServerDir } from './commercial-drafting-test.mjs';
export const withPreCreationMigrations = async test => {
  const d = await mkdtemp(join(tmpdir(), 'workos-creation-065-upgrade-'));
  try {
    await mkdir(join(d, 'migrations')); await copyFile(join(commercialServerDir, 'schema.sql'), join(d, 'schema.sql'));
    for (const n of await readdir(join(commercialServerDir, 'migrations'))) if (/^\d{3}[a-z]?_.*\.sql$/.test(n) && Number(n.slice(0, 3)) < 66) await copyFile(join(commercialServerDir, 'migrations', n), join(d, 'migrations', n));
    return await test(d);
  } finally { await rm(d, { recursive: true, force: true }); }
};
