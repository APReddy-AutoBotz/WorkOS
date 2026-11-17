import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {parse} from 'dotenv';
import {expand} from 'dotenv-expand';

export async function loadFrontendEnvironment(root, mode) {
  if (!/^[a-zA-Z0-9_-]+$/.test(mode) || mode === 'local') throw new Error('Invalid frontend mode');
  const fileEnv = {};
  for (const name of ['.env', '.env.local', '.env.' + mode, '.env.' + mode + '.local']) {
    try {
      Object.assign(fileEnv, parse(await readFile(path.join(root, name))));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return {...expand({parsed: fileEnv, processEnv: {...process.env}}).parsed, ...process.env};
}
