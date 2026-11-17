import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {parse} from 'dotenv';
import {expand} from 'dotenv-expand';

export function publicFrontendEnvironment(environment, mode, production) {
  const exposed = Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('VITE_')));
  return {...exposed, BASE_URL: '/', MODE: mode, PROD: production, DEV: !production, SSR: false,
    VITE_APP_MODE: environment.APP_MODE || exposed.VITE_APP_MODE || 'demo',
    VITE_DISABLE_DEMO_FALLBACK: environment.DISABLE_DEMO_FALLBACK || exposed.VITE_DISABLE_DEMO_FALLBACK || 'false'};
}

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
