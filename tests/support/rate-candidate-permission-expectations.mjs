import assert from 'node:assert/strict';
const expected=[
 {permission_key:'commercial.retainer_statements.decide',module:'Commercial',label:'Review retainer statements',description:'Independently approve or reject a retained period statement.',protected:false},
 {permission_key:'commercial.retainer_statements.prepare',module:'Commercial',label:'Prepare retainer statements',description:'Retain closed-period pricing and approved work evidence for review.',protected:false},
 {permission_key:'commercial.fixed_fee_eligibility.issue',module:'Commercial',label:'Approve due fixed-fee installments',description:'Independently approve a due contract installment for a selected engagement and inspect its register receipt.',protected:false},
 {permission_key:'commercial.purchase_orders.release',module:'Commercial',label:'Release purchase orders',description:'Independently release an in-force purchase order against its active contract terms.',protected:false},
 {permission_key:'commercial.reversal_eligibility.create',module:'Commercial',label:'Issue approved reversal eligibility',description:'Create a signed approved-unbilled item from an independently approved full-line reversal.',protected:false},
 {permission_key:'periods.financial_reopen',module:'Admin',label:'Reopen financial periods',description:'Permit a financial lock to return to Approval Closed with a recorded reason.',protected:false},
 {permission_key:'commercial.milestone_billing.view',module:'Commercial',label:'View milestone billing review',description:'View scoped milestone acceptance and eligibility evidence.',protected:false},
 {permission_key:'commercial.milestone_billing.manage',module:'Commercial',label:'Manage milestone billing review',description:'Configure and request scoped milestone billing review.',protected:false},
 {permission_key:'commercial.milestone_billing.decide',module:'Commercial',label:'Decide milestone billing review',description:'Decide a named scoped milestone billing review stage.',protected:false},
 {permission_key:'commercial.invoice_batch.confirm',module:'Commercial',label:'Confirm downstream invoice billing',description:'Record an explicit scoped human attestation for an exported invoice-ready artifact.',protected:false},
 {permission_key:'commercial.invoice_export.configure',module:'Commercial',label:'Configure invoice export notices',description:'Configure prospective scoped invoice-export recipient and template policy.',protected:false},
 {permission_key:'commercial.invoice_export.recover_notices',module:'Commercial',label:'Recover invoice export notices',description:'Attempt scoped recovery of incomplete invoice-export notification evidence.',protected:false},
 {permission_key:'integrations.invoice_alert_routes.manage',module:'Integrations',label:'Manage invoice alert routes',description:'Configure prospective invoice operational-alert outbox routes.',protected:false},
 {permission_key:'commercial.invoice_export.view',module:'Commercial',label:'View invoice CSV artifacts',description:'Retrieve scoped retained invoice-ready CSV artifact bytes.',protected:false},
 {permission_key:'commercial.invoice_export.create',module:'Commercial',label:'Create invoice CSV artifacts',description:'Accept one approved scoped invoice-ready CSV artifact.',protected:false},
 {permission_key:'commercial.invoice_approval.manage',module:'Commercial',label:'Manage invoice batch approvals',description:'Configure prospective scoped invoice batch approval and submit Drafts.',protected:false},
 {permission_key:'commercial.invoice_approval.decide',module:'Commercial',label:'Decide invoice batch approvals',description:'Decide an explicitly assigned current scoped invoice batch approval stage.',protected:false},
 {permission_key:'commercial.invoice_drafts.view',module:'Commercial',label:'View invoice-ready drafts',description:'View scoped draft batches and their billing-safe item lineage.',protected:false},
 {permission_key:'commercial.invoice_drafts.prepare',module:'Commercial',label:'Prepare invoice-ready drafts',description:'Create scoped draft batches and acquire eligible whole items.',protected:false},
 {permission_key:'commercial.invoice_drafts.own',module:'Commercial',label:'Own invoice-ready drafts',description:'Be an explicitly named scoped draft owner.',protected:false},
 {permission_key:'commercial.invoice_drafts.cancel',module:'Commercial',label:'Cancel invoice-ready drafts',description:'Cancel a scoped draft and release current occupancy with retained history.',protected:false},
 {permission_key:'commercial.tm_billing.view',module:'Commercial',label:'View T&M billing eligibility',description:'View scoped T&M billing-safe approval and register evidence.',protected:false},
 {permission_key:'commercial.tm_billing.manage',module:'Commercial',label:'Manage T&M billing eligibility',description:'Configure explicit review and request T&M eligibility in scope.',protected:false},
 {permission_key:'commercial.tm_billing.decide',module:'Commercial',label:'Decide T&M billing eligibility',description:'Decide an explicitly assigned in-scope T&M eligibility stage.',protected:false},
 {permission_key:'commercial.tm_valuation.view',module:'Commercial',label:'View protected T&M valuation',description:'View scoped native-currency T&M snapshots, with separately held billing and cost access.',protected:false},
 {permission_key:'commercial.tm_valuation.create',module:'Commercial',label:'Create protected T&M valuation',description:'Configure scoped T&M policy and create source-bound snapshots, with separately held billing and cost access.',protected:false},
 {permission_key:'commercial.cost_approvals.decide',module:'Commercial',label:'Decide cost candidate approvals',description:'Decide an explicitly assigned scoped confidential cost candidate approval.',protected:false},
 {permission_key:'commercial.rate_approvals.decide',module:'Commercial',label:'Decide billing candidate approvals',description:'Decide an explicitly assigned scoped billing candidate approval.',protected:false},
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
 assert.equal(added.length,expected.length,'exactly the specified opt-in definitions are added');
 assert.deepEqual(added.map(({created_at,...row})=>{assert.equal(typeof created_at,'string');return row;}),[...expected].sort((a,b)=>a.permission_key.localeCompare(b.permission_key)),'new definition metadata matches the explicit migration contract');
};
