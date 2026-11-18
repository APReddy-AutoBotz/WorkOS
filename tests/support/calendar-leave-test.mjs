import {mkdtemp,mkdir,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {commercialServerDir} from './commercial-drafting-test.mjs';
export const withPreCalendarLeaveMigrations=async test=>{const d=await mkdtemp(join(tmpdir(),'workos-calendar-leave-upgrade-'));try{await mkdir(join(d,'migrations'));await copyFile(join(commercialServerDir,'schema.sql'),join(d,'schema.sql'));for(const name of await readdir(join(commercialServerDir,'migrations')))if(/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(name)&&Number(name.slice(0,3))<61)await copyFile(join(commercialServerDir,'migrations',name),join(d,'migrations',name));return await test(d);}finally{await rm(d,{recursive:true,force:true});}};
