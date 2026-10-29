import assert from 'node:assert/strict';
import {readBillingReconciliation} from '../server/modules/invoice-drafts/reconciliation.mjs';
import {reconciliationCsv,reconciliationToken} from '../server/modules/invoice-drafts/reconciliation-csv.mjs';

const scope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
const req={organizationScope:scope};
const row=(n,currency='USD')=>({itemId:`item-${n}`,itemVersion:1,eventId:`event-${n}`,eventVersion:1,
  sourceType:'TM_SNAPSHOT',snapshotId:`source-${n}`,engagementId:'synthetic-engagement',currency,amount:'0.0001',
  sourceCurrency:currency,sourceAmount:'0.0001',sourceMatches:true,sourceCurrent:true,batchId:null,lineId:null,
  lineAmount:null,lineCurrency:null,batchState:null,artifactId:null,artifactHash:null,confirmationId:null,
  lineMatches:true,artifactMatches:true,history:[],historicalLineCount:0});
const fake=(rows,missing=[])=>({query:async sql=>sql.includes('select ev.id as "eventId"')?{rows:missing}:sql.includes('from approved_unbilled_items item')?{rows}:{rows:[{ts:new Date('2026-01-01T00:00:00Z')}]}});
const options={buildEmployeeScopeWhere:()=>"true"};
const atLimit=await readBillingReconciliation(fake(Array.from({length:500},(_,n)=>row(n))),req,'synthetic-engagement',options);
assert.equal(atLimit.items.length,500);
assert.equal(atLimit.controls.find(c=>c.boundary==='REGISTER_ITEM').amount,'0.05');
await assert.rejects(readBillingReconciliation(fake(Array.from({length:501},(_,n)=>row(n))),req,'synthetic-engagement',options),e=>e.statusCode===422&&e.code==='BILLING_RECONCILIATION_LIMIT');
const missing={eventId:'missing',snapshotId:'missing-source',currency:'USD',amount:'1.0000',sourceCurrency:'USD',sourceAmount:'1.0000'};
const exception=await readBillingReconciliation(fake([row(0)],[missing]),req,'synthetic-engagement',options);
assert.equal(exception.exceptionCount,1);assert.equal(exception.controls.find(c=>c.boundary==='ELIGIBILITY_EVENT').amount,'1.0001');
assert.equal(exception.controls.find(c=>c.boundary==='REGISTER_ITEM').amount,'0.0001');
await assert.rejects(readBillingReconciliation(fake(Array.from({length:500},(_,n)=>row(n)),[missing]),req,'synthetic-engagement',options),e=>e.statusCode===422&&e.code==='BILLING_RECONCILIATION_LIMIT');
const mixed=await readBillingReconciliation(fake([row(1),row(2,'EUR')]),req,'synthetic-engagement',options);
assert.deepEqual(mixed.controls.filter(c=>c.boundary==='REGISTER_ITEM').map(c=>[c.currency,c.amount]),[['EUR','0.0001'],['USD','0.0001']]);
const token=reconciliationToken(scope,mixed),csv=reconciliationCsv({...scope,organizationId:'=synthetic'},mixed,token);
assert(csv.includes('"\'=synthetic"'),'Spreadsheet formula prefixes must be escaped');
assert(csv.includes('EVENT_BACKED_SOURCE')&&csv.includes('REGISTER_ITEM'));
assert(csv.trimEnd().split('\r\n').every(line=>line.split('","').length===23),'Every CSV row must have the declared columns');
console.log('Scoped reconciliation 500/501 boundary, currency isolation and CSV escaping passed.');
