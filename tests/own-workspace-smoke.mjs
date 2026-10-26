import assert from 'node:assert/strict';
import{ownWorkspaceSelection,ownLeaveCursor,ownBalanceCursor,OWN_WORKSPACE_REQUIRED}from'../shared/own-workspace.mjs';
assert.deepEqual(ownWorkspaceSelection('2026-10-01','2026-10-26'),{startsOn:'2026-10-01',endsOn:'2026-10-26'});
for(const p of[['2026-02-30','2026-03-01'],['2026-10-26','2026-10-01'],['2024-01-01','2026-01-01']])assert.equal(ownWorkspaceSelection(...p),null);
assert(ownLeaveCursor('2026-10-26|synthetic|arbitrary-id'));assert(ownBalanceCursor('2026|synthetic|arbitrary-id'));
for(const c of['2026-02-30|x','2026-10-26|','|x'])assert.equal(ownLeaveCursor(c),false);
for(const c of['1999|x','2101|x','2026|','2026bad'])assert.equal(ownBalanceCursor(c),false);
assert.deepEqual(OWN_WORKSPACE_REQUIRED,['employee_workspace.view','employees.view']);
console.log('Own workspace explicit selection, bounded continuation cursor and existing permission contracts passed.');
