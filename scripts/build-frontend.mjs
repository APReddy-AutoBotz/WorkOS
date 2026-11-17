import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, cp, rm, mkdir} from 'node:fs/promises';
import {loadFrontendEnvironment} from './frontend-environment.mjs';
import {build} from 'esbuild';
import {frontendStyles} from './frontend-styles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const environment = await loadFrontendEnvironment(root, 'production');
const publicEnv = Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('VITE_')));
Object.assign(publicEnv, {
  BASE_URL: '/', MODE: 'production', PROD: true, DEV: false, SSR: false,
  VITE_APP_MODE: environment.APP_MODE || publicEnv.VITE_APP_MODE || 'demo',
  VITE_DISABLE_DEMO_FALLBACK: environment.DISABLE_DEMO_FALLBACK || publicEnv.VITE_DISABLE_DEMO_FALLBACK || 'false',
});

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'], outdir: output, bundle: true, minify: true,
  format: 'esm', splitting: true, target: 'es2020', metafile: true, write: false,
  entryNames: 'assets/[name]-[hash]', chunkNames: 'assets/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
  define: {'import.meta.env': JSON.stringify(publicEnv), 'process.env.NODE_ENV': '"production"'},
  plugins: [frontendStyles(root)],
});

const [entry, metadata] = Object.entries(result.metafile.outputs).find(([, item]) => item.entryPoint === 'src/main.tsx');
const assetUrl = file => '/' + path.relative(output, path.resolve(root, file)).split(path.sep).join('/');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const title = publicEnv.VITE_PRODUCT_NAME?.trim() || 'WorkOS';
const icon = publicEnv.VITE_PRODUCT_LOGO_URL?.trim() || '/workos-mark.svg';
const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
  .replace('<title>WorkOS</title>', () => '<title>' + escape(title) + '</title>')
  .replace('href="/workos-mark.svg"', () => 'href="' + escape(icon) + '"')
  .replace('</head>', '<link rel="stylesheet" href="' + assetUrl(metadata.cssBundle) + '" />\n  </head>')
  .replace('src="/src/main.tsx"', 'src="' + assetUrl(entry) + '"');

await rm(output, {recursive: true, force: true});
await cp(path.join(root, 'public'), output, {recursive: true});
await mkdir(path.join(output, 'assets'), {recursive: true});
await Promise.all(result.outputFiles.map(file => writeFile(file.path, file.contents)));
await writeFile(path.join(output, 'index.html'), html);
