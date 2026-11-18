import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {commercialFixture as f,commercialServerDir} from './commercial-drafting-test.mjs';
import {seedActualWork,actualCapacityDefinition} from './actual-work-test.mjs';
import {nativeCheckpoint} from '../../shared/native-forecast.mjs';
export const withPreNativeMigrations=async test=>{const d=await mkdtemp(join(tmpdir(),'workos-native-forecast-upgrade-'));try{await mkdir(join(d,'migrations'));await copyFile(join(commercialServerDir,'schema.sql'),join(d,'schema.sql'));for(const name of await readdir(join(commercialServerDir,'migrations')))if(/^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(name)&&Number(name.slice(0,3))<62)await copyFile(join(commercialServerDir,'migrations',name),join(d,'migrations',name));return await test(d);}finally{await rm(d,{recursive:true,force:true});}};
export const seedNativeForecast=async pool=>seedActualWork(pool);
export const adoptNativeForecast=async(request,today)=>{
 let r=await request('/api/v1/worker-capacity/workers/'+f.ownerId+'/profiles',{method:'POST',body:{expectedLatestId:null,effectiveFrom:today,definition:actualCapacityDefinition,reason:'Synthetic explicit forecast capacity'}});assert.equal(r.status,201,JSON.stringify(r.body));
 const add=async(percentage,start=today,end=nativeCheckpoint(today,3),status='Active')=>{const v=await request('/api/allocations',{method:'POST',body:{employee_id:f.ownerId,project_id:f.projectId,percentage,start_date:start,end_date:end,billable:true,status}});assert.equal(v.status,200,JSON.stringify(v.body));return v.body.id;};
 const primary=await add(20),split=await add(5,today,nativeCheckpoint(today,1)),zero=await add(0),paused=await add(80,today,nativeCheckpoint(today,3),'Paused');return{primary,split,zero,paused};
};
