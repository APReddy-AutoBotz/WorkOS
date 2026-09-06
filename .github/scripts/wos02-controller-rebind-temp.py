from pathlib import Path
import re

workflow = Path('.github/workflows/wos02-final-review-acceptance.yml')
text = workflow.read_text()
old_head = 'TARGET_HEAD: 436ac4ad7f984cd402495d25a8d2799a9947f217'
new_head = 'TARGET_HEAD: ff278306c5394d3c43d0c860a736d783ad59d19c'
old_tree = 'TARGET_TREE: d7ceedbd604fc0cc35febc28600ef006990b0484'
new_tree = 'TARGET_TREE: d81d00223cc64d1db25695395bc0b696f82e34cd'
if text.count(old_head) != 1 or text.count(old_tree) != 1:
    raise SystemExit('controller workflow authority anchors are not exact')
text = text.replace(old_head, new_head).replace(old_tree, new_tree)
workflow.write_text(text)

script = Path('.github/scripts/wos02-mutation-lifecycle-acceptance.mjs')
source = script.read_text()

source, count = re.subn(
    r"^ await check\('stale or equal exit history is stable no-write conflict'.*$",
    """ await check('already-exited same-date direct replay preserves authoritative lifecycle state',async()=>{ const before=await workerState(directId); const r=await call('POST','/api/employees',{token,body:{...employeeBody('E-P1-DIRECT',{status:'Exited',exit_date:'2026-08-01'}),initial_password:undefined}}); assert.equal(r.status,200,JSON.stringify(r.body)); const after=await workerState(directId); assert.equal(String(after.employee.exit_date).slice(0,10),'2026-08-01'); assert.equal(after.employee.status,'Exited'); assert.equal(after.profile.lifecycle_status,'Exited'); assert.equal(after.user.status,'Disabled'); assert.equal(after.scopes.find(s=>s.organization_id==='org-p1'&&s.legal_entity_id==='legal-p1-a')?.active,false); assert.equal(after.history.length,before.history.length); });
 await check('already-exited omitted-date direct replay preserves authoritative lifecycle state',async()=>{ const before=await workerState(directId); const r=await call('POST','/api/employees',{token,body:{...employeeBody('E-P1-DIRECT',{status:'Exited'}),initial_password:undefined}}); assert.equal(r.status,200,JSON.stringify(r.body)); const after=await workerState(directId); assert.equal(String(after.employee.exit_date).slice(0,10),'2026-08-01'); assert.equal(after.history.length,before.history.length); assert.equal(after.user.status,'Disabled'); assert.equal(after.scopes.find(s=>s.organization_id==='org-p1'&&s.legal_entity_id==='legal-p1-a')?.active,false); });
 await check('already-exited different-date direct replay is stable no-write conflict',async()=>{ const before=await workerState(directId); const r=await call('POST','/api/employees',{token,body:{...employeeBody('E-P1-DIRECT',{status:'Exited',exit_date:'2026-01-01'}),initial_password:undefined}}); assert.equal(r.status,409,JSON.stringify(r.body)); assert.ok(hasCode(r.body,'WORKER_VERSION_CONFLICT')); assertUnchanged(before,await workerState(directId)); });""",
    source,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit('direct exit replay controller anchor not exact')

source, count = re.subn(
    r"^ await check\('employee import partial processing blocks unsafe exit and converges allowed exit'.*$",
    """ let importAllowedId;
 await check('employee import partial processing blocks unsafe exit and converges allowed exit',async()=>{ const a=await call('POST','/api/employees',{token,body:employeeBody('E-P1-IMPORT-OK')}); importAllowedId=a.body.id; const beforeBlocked=await workerState(blockedId); const payload={fileName:'p1-exits.csv',rows:[{...importRow('E-P1-BLOCK',{status:'Exited',exitDate:'2026-09-01'}),initialPassword:undefined},{...importRow('E-P1-IMPORT-OK',{status:'Exited',exitDate:'2026-09-01'}),initialPassword:undefined}]}; const r=await call('POST','/api/imports/employees/apply',{token,body:payload}); assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.status,'Partial'); assert.ok(hasCode(r.body,'WORKER_DEPENDENCY_CONFLICT')); assertUnchanged(beforeBlocked,await workerState(blockedId)); assertExited(await workerState(importAllowedId)); });
 await check('already-exited same-date employee import replay preserves authoritative lifecycle state',async()=>{ const before=await workerState(importAllowedId); const r=await call('POST','/api/imports/employees/apply',{token,body:{fileName:'p1-exit-same-date.csv',rows:[{...importRow('E-P1-IMPORT-OK',{status:'Exited',exitDate:'2026-09-01'}),initialPassword:undefined}]}}); assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.status,'Success',JSON.stringify(r.body)); const after=await workerState(importAllowedId); assert.equal(String(after.employee.exit_date).slice(0,10),'2026-09-01'); assert.equal(after.employee.status,'Exited'); assert.equal(after.profile.lifecycle_status,'Exited'); assert.equal(after.user.status,'Disabled'); assert.equal(after.scopes.find(s=>s.organization_id==='org-p1'&&s.legal_entity_id==='legal-p1-a')?.active,false); assert.equal(after.history.length,before.history.length); });
 await check('already-exited different-date employee import conflict is row-local and partial',async()=>{ const valid=await call('POST','/api/employees',{token,body:employeeBody('E-P1-IMPORT-PARTIAL')}); assert.equal(valid.status,200,JSON.stringify(valid.body)); const before=await workerState(importAllowedId); const r=await call('POST','/api/imports/employees/apply',{token,body:{fileName:'p1-exit-replay-partial.csv',rows:[{...importRow('E-P1-IMPORT-OK',{status:'Exited',exitDate:'2026-10-01'}),initialPassword:undefined},{...importRow('E-P1-IMPORT-PARTIAL',{name:'E-P1-IMPORT-PARTIAL-UPDATED',status:'Active'}),initialPassword:undefined}]}}); assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.status,'Partial',JSON.stringify(r.body)); assert.ok(hasCode(r.body,'WORKER_VERSION_CONFLICT'),JSON.stringify(r.body)); assertUnchanged(before,await workerState(importAllowedId)); const validAfter=await workerState(valid.body.id); assert.equal(validAfter.employee.name,'E-P1-IMPORT-PARTIAL-UPDATED'); });""",
    source,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit('employee import controller anchor not exact')

source, count = re.subn(
    r"(\n scopes:.*\n)( audit:Number)",
    r"\1 mappings:(await pool.query(`select country_director_id from employee_country_director_map where employee_id=$1 order by 1`,[id])).rows,\n roles:(await pool.query(`select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=(select id from users where employee_record_id=$1) order by r.name`,[id])).rows,\n\2",
    source,
    count=1,
)
if count != 1:
    raise SystemExit('worker state controller anchor not exact')

script.write_text(source)
