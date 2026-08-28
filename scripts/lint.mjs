import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const roots = ['scripts', 'server', 'tests'];
const modules = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (['.cjs', '.mjs'].includes(extname(entry.name))) modules.push(path);
  }
}

for (const root of roots) collect(root);
for (const module of modules.sort()) {
  execFileSync(process.execPath, ['--check', module], { stdio: 'inherit' });
}

console.log(`Syntax-checked ${modules.length} JavaScript modules.`);
