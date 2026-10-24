import {mkdtemp,mkdir,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {commercialServerDir} from './commercial-drafting-test.mjs';
export const withPreOverlapMigrations=async test=>{const d=await mkdtemp(join(tmpdir(),'workos-assignment-overlap-upgrade-'));try{await mkdir(join(d,'migrations'));await copyFile(join(commercialServerDir,'schema.sql'),join(d,'schema.sql'));for(const f of await readdir(join(commercialServerDir,'migrations')))if(/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(f)&&Number(f.slice(0,3))<58)await copyFile(join(commercialServerDir,'migrations',f),join(d,'migrations',f));return await test(d);}finally{await rm(d,{recursive:true,force:true});}};
