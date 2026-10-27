import assert from 'node:assert/strict';
const expected=[
 {permission_key:'commercial.cost_candidates.manage',module:'Commercial',label:'Manage cost rate candidates',description:'Append scoped, unapproved confidential cost candidate versions.',protected:false},
 {permission_key:'commercial.cost_candidates.view',module:'Commercial',label:'View cost rate candidates',description:'View scoped, unapproved confidential cost candidates and their previews.',protected:false},
 {permission_key:'commercial.rate_candidates.manage',module:'Commercial',label:'Manage billing rate candidates',description:'Append scoped, unapproved billing rate candidate versions.',protected:false},
 {permission_key:'commercial.rate_candidates.view',module:'Commercial',label:'View billing rate candidates',description:'View scoped, unapproved billing rate candidates and their previews.',protected:false},
];
export const assertRateCandidatePermissionAdditions=(before,after)=>{
 const keys=new Set(expected.map(x=>x.permission_key));
 assert(before.every(x=>!keys.has(x.permission_key)),'candidate permissions were not present in the old ledger');
 assert.deepEqual(after.filter(x=>!keys.has(x.permission_key)),before,'all earlier permission definitions remain byte-equivalent');
 const added=after.filter(x=>keys.has(x.permission_key)).sort((a,b)=>a.permission_key.localeCompare(b.permission_key));
 assert.equal(added.length,expected.length,'exactly the four specified opt-in definitions are added');
 assert.deepEqual(added.map(({created_at,...row})=>{assert.equal(typeof created_at,'string');return row;}),expected,'new definition metadata matches the explicit migration contract');
};
