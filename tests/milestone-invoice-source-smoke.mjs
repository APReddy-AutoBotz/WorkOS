import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {milestoneInvoiceItemMatches} from '../shared/milestone-invoice-source.mjs';
import {milestoneInvoiceCsvArtifact,MILESTONE_INVOICE_CSV_SCHEMA} from '../server/modules/invoice-export/milestone-csv.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const draft={clientId:'=synthetic-client',contractId:'@synthetic-contract',engagementId:'synthetic-engagement',currency:'USD',periodStart:'2026-10-01',periodEnd:'2026-10-31',periodBasis:'ELIGIBLE_DATE',ownerUserId:id(1),ownerRole:'Admin'};
const evidence={milestoneId:'=synthetic-milestone',sourceVersion:1,engagementId:draft.engagementId,contractVersionId:'synthetic-version',engagementLifecycleId:'synthetic-eng-lifecycle',contractLifecycleId:'synthetic-contract-lifecycle',dueOn:'2026-10-20',evidence:[{kind:'CLIENT_EVIDENCE_ASSERTION',reference:'Synthetic client acceptance',url:'https://example.test/evidence'}],ownerUserId:id(2),ownerRole:'Admin',policyId:id(3),decisionId:id(4),currency:'USD',amount:'125.1500'};
const item={sourceType:'MILESTONE_ACCEPTANCE',itemId:id(5),itemVersion:1,eventId:id(6),clientId:draft.clientId,contractId:draft.contractId,engagementId:draft.engagementId,currency:'USD',eligibleOn:'2026-10-21',amount:'125.15',current:true,evidence};
assert.equal(milestoneInvoiceItemMatches(draft,item),true);
for(const change of [{sourceType:'TM_SNAPSHOT'},{current:false},{itemVersion:2},{clientId:'other'},{currency:'EUR'},{amount:'125.16'},{eligibleOn:'2026-11-01'}])assert.equal(milestoneInvoiceItemMatches(draft,{...item,...change}),false);
for(const change of [{decisionId:'bad'},{sourceVersion:2},{engagementId:'other'},{evidence:[]},{amount:'0'},{currency:'EUR'}])assert.equal(milestoneInvoiceItemMatches(draft,{...item,evidence:{...evidence,...change}}),false);
assert.equal(milestoneInvoiceItemMatches({...draft,periodBasis:'WORK_DATE'},item),false);
const line={lineId:id(7),sequence:1,itemId:item.itemId,itemVersion:1,eventId:item.eventId,sourceType:item.sourceType,currency:'USD',amount:'125.15',eligibleDate:item.eligibleOn,evidenceJson:JSON.stringify(evidence)},source={...draft,batchId:id(8),lines:[line]};
const artifact=milestoneInvoiceCsvArtifact(source),again=milestoneInvoiceCsvArtifact(source);
assert.equal(artifact.schemaVersion,MILESTONE_INVOICE_CSV_SCHEMA);assert.deepEqual(artifact.bytes,again.bytes);assert.equal(artifact.sha256,createHash('sha256').update(artifact.bytes).digest('hex'));assert.equal(artifact.total,'125.15');
const cells=artifact.bytes.toString('utf8').split('\r\n')[1].split(',');assert.equal(Buffer.from(cells[8].slice(4),'base64').toString(),evidence.milestoneId);assert.equal(Buffer.from(cells[9].slice(4),'base64').toString(),line.evidenceJson);assert(cells.every(x=>!['=','+','-','@'].includes(x[0])));
assert.throws(()=>milestoneInvoiceCsvArtifact({...source,lines:[line,{...line,sequence:2}]}));assert.throws(()=>milestoneInvoiceCsvArtifact({...source,lines:[{...line,amount:'125.16'}]}));assert.throws(()=>milestoneInvoiceCsvArtifact({...source,periodBasis:'WORK_DATE'}));assert.throws(()=>milestoneInvoiceCsvArtifact({...source,lines:[{...line,evidenceJson:'{}'}]}));
console.log('Milestone invoice retained source and deterministic CSV contracts passed.');
