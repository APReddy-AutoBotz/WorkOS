// Run inside the packaged image so notices match the installed dependencies.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function collectNotices(root, directory = '') {
  const files = [];
  const entries = await readdir(join(root,directory),{withFileTypes:true});
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    const file = directory ? directory + '/' + entry.name : entry.name;
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...await collectNotices(root,file));
    } else if (entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:$|[.-])/i.test(entry.name)) {
      files.push({file,text:await readFile(join(root,file),'utf8')});
    }
  }
  // Some packages publish their notice in the README instead of a dedicated file.
  if (!directory && !files.some(item => !item.file.includes('/'))) {
    const readme = entries.find(entry => entry.isFile() && /^readme(?:\.md|\.txt)?$/i.test(entry.name));
    if (readme) {
      const body = await readFile(join(root,readme.name),'utf8');
      const heading = /^#{1,6}[ \t]+licen[cs]es?[ \t]*\r?$/im.exec(body);
      if (heading) {
        const rest = body.slice(heading.index + heading[0].length);
        const next = rest.search(/^#{1,6}[ \t]+/m);
        files.push({file:readme.name,section:'License',text:heading[0] + (next < 0 ? rest : rest.slice(0,next))});
      }
    }
  }
  return files;
}

const installed = JSON.parse(await readFile('node_modules/.package-lock.json', 'utf8'));
const packages = [];
for (const location of Object.keys(installed.packages).sort()) {
  if (!location.startsWith('node_modules/') || location.split('/').includes('..')) {
    throw new Error('Unexpected installed-package path');
  }
  const manifest = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
  const notices = await collectNotices(location);
  packages.push({location, name:manifest.name, version:manifest.version, license:manifest.license ?? null, notices});
}
if (!packages.length || !packages.some(pkg => pkg.notices.length)) throw new Error('Installed notices unavailable');
process.stdout.write(JSON.stringify({
  packages,
  packagesWithoutRootNotice:packages.filter(pkg => !pkg.notices.some(item => !item.file.includes('/'))).map(pkg => pkg.location),
}, null, 2) + '\n');
