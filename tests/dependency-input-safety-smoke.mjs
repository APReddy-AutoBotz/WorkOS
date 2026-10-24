import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {gzipSync,deflateSync} from 'node:zlib';
import {clientProfileSchema} from '../server/modules/client-profiles/contracts.mjs';
import {validateWorkingCalendar} from '../server/working-calendars.mjs';

if(process.argv.includes('--parser-fixture')){
  // Match the production JSON boundary without risking the test process when
  // an unhandled decompressor error terminates a vulnerable dependency.
  const {default:express}=await import('express');
  const app=express();app.use(express.json({limit:'1mb'}));
  app.get('/alive',(_req,res)=>res.json({alive:true}));
  app.post('/input',(req,res)=>res.json(req.body));
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({rejected:true}));
  const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
  process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
}else{
  const child=fork(fileURLToPath(import.meta.url),['--parser-fixture'],{stdio:['ignore','ignore','pipe','ipc']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-2000);});
  try{
    const address=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Parser fixture did not start.')),5000);
      child.once('message',value=>{clearTimeout(timeout);resolve(value);});
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Parser fixture exited before startup.'));});
    });
    const origin=`http://127.0.0.1:${address.port}`;
    const json=Buffer.from('{"synthetic":true}');
    const send=(body,encoding)=>fetch(`${origin}/input`,{method:'POST',headers:{'Content-Type':'application/json',
      ...(encoding?{'Content-Encoding':encoding}:{})},body,signal:AbortSignal.timeout(3000)});
    assert.deepEqual(await (await send(json)).json(),{synthetic:true});
    for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync]]){
      const compressed=compress(json);
      assert.deepEqual(await (await send(compressed,encoding)).json(),{synthetic:true});
      // A complete frame followed by padding and enough trailing bytes to
      // arrive after decoder completion reproduced the unhandled gzip crash.
      const trailing=Buffer.concat([compressed,Buffer.from([0]),Buffer.alloc(128*1024,88)]);
      const response=await send(trailing,encoding);
      assert([200,400].includes(response.status),'trailing input must complete or be rejected');
      await response.arrayBuffer();await delay(100);
      assert.equal(child.exitCode,null,`Parser must survive ${encoding} trailing bytes: ${diagnostics}`);
      assert.equal((await fetch(`${origin}/alive`,{signal:AbortSignal.timeout(3000)})).status,200);
      assert.equal((await send(Buffer.from('invalid compressed input'),encoding)).status,400);
    }
    const oversized=await send(Buffer.alloc(1024*1024+1,32));
    assert.equal(oversized.status,413,'the existing decoded JSON limit remains enforced');
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  }
  const profile={code:'SYNTHETIC',expectedVersion:0,parentClientId:null,effectiveFrom:'2026-01-01',
    legalName:'Synthetic client',displayName:null,defaultCurrency:'USD',reason:'Synthetic validation',
    billingContacts:[{name:'Synthetic contact',email:'synthetic@example.test'}]};
  assert.equal(clientProfileSchema.safeParse(profile).success,true);
  assert.equal(clientProfileSchema.safeParse({...profile,billingContacts:[]}).success,true);
  const invalid=clientProfileSchema.safeParse({...profile,billingContacts:Array(1000).fill(0)});
  assert.equal(invalid.success,false);assert.equal(invalid.error.issues.length,1);
  assert.equal(invalid.error.issues[0].code,'too_big');assert.deepEqual(invalid.error.issues[0].path,['billingContacts']);
  const calendar={code:'SYNTHETIC',name:'Synthetic calendar',timezone:'UTC',workingDays:[1,2,3,4,5],
    hoursPerDay:8,effectiveFrom:'2026-01-01',applicability:{type:'legal_entity'}};
  assert.equal(validateWorkingCalendar(calendar).success,true);
  const invalidDays=validateWorkingCalendar({...calendar,workingDays:Array(1000).fill(null)});
  assert.equal(invalidDays.success,false);assert.equal(invalidDays.error.issues.length,1);
  assert.equal(invalidDays.error.issues[0].code,'too_big');assert.deepEqual(invalidDays.error.issues[0].path,['workingDays']);
  console.log('Dependency input safety passed: compressed parser survival, ordinary JSON and decoded size limit; bounded profile/calendar rejection before element validation.');
}
