import {ApiClientError} from './apiClient';
import {invoiceBatchApprovals,type InvoiceApprovalSource,type InvoiceBatchApproval,type InvoiceApprovalOperation} from './invoiceBatchApprovals';
import {isTypeContextCurrent,type TypeContext} from './workerType';
import {canonicalHours} from '../../shared/work-hours.mjs';
import {approvalUuid} from '../../shared/work-approval.mjs';

type Decision = 'Approved' | 'Rejected';
type DecisionOperation = Extract<InvoiceApprovalOperation,{type:'decision'}>;
export type ReviewedInvoice = Readonly<{engagementId:string; approval:InvoiceBatchApproval; batch:InvoiceApprovalSource; operation:DecisionOperation; actorId:string; activeRole:string; ownerKey:string}>;
export type InvoiceBatchResult = {requestId:string;status:'Confirmed'|'Denied'|'Uncertain'|'NotAttempted';httpStatus?:number;approval?:InvoiceBatchApproval};
const freeze=<T,>(value:T):T=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const reviewInvoiceDecision=(page:Awaited<ReturnType<typeof invoiceBatchApprovals.inspect>>,decision:Decision,reason:string,requestId=crypto.randomUUID()):ReviewedInvoice=>{
 const {approval,batch}=page,stage=approval.state.currentStage;
 if(!approval.current||approval.state.status!=='Pending'||stage===null||!batch.current||batch.state!=='Under Review'||approval.batchId!==batch.id||approval.lineageHash!==batch.lineageHash||approval.lineCount!==batch.lineCount||approval.currency!==batch.currency||canonicalHours(approval.total)!==canonicalHours(batch.total)||!approvalUuid(requestId)||!['Approved','Rejected'].includes(decision)||reason.trim().length<3||reason.trim().length>1000)throw Error('Inspect a current invoice review and enter a decision and reason.');
 const operation:DecisionOperation={type:'decision',id:approval.id,data:{requestId,expectedSequence:approval.state.sequence,decision,reason:reason.trim()}};
 return freeze(JSON.parse(JSON.stringify({engagementId:batch.engagementId,approval,batch,operation,actorId:page.actorUserId,activeRole:page.activeRole,ownerKey:page.ownerKey})) as ReviewedInvoice);
};
export const executeReviewedInvoices=async(items:readonly ReviewedInvoice[],ctx:TypeContext|null,live:()=>boolean,report:(result:InvoiceBatchResult)=>void)=>{
 if(!items.length||items.length>20||new Set(items.map(i=>i.approval.id)).size!==items.length||new Set(items.map(i=>i.operation.data.requestId)).size!==items.length)throw Error('Select one to twenty distinct reviewed invoice sources.');
 let stopped=false;const key=ctx?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))))).map(x=>x.toString(16).padStart(2,'0')).join(''):null;
 for(const item of items){const requestId=item.operation.data.requestId;
  if(stopped||!ctx||!live()||!isTypeContextCurrent(ctx)||key!==item.ownerKey||ctx.activeRole!==item.activeRole){report({requestId,status:'NotAttempted'});stopped=true;continue;}
  try{const approval=await invoiceBatchApprovals.run(item.operation,item.engagementId,ctx);if(!('batchId' in approval)||!live()||!isTypeContextCurrent(ctx)){report({requestId,status:'Uncertain'});stopped=true;}else report({requestId,status:'Confirmed',approval});}
  catch(error){const httpStatus=error instanceof ApiClientError?error.status:undefined;const definitive=live()&&isTypeContextCurrent(ctx)&&httpStatus!==undefined&&[400,403,404,409,422].includes(httpStatus);report({requestId,status:definitive?'Denied':'Uncertain',httpStatus});if(!definitive)stopped=true;}
 }
};
export const reconcileReviewedInvoice=async(item:ReviewedInvoice,ctx:TypeContext|null):Promise<InvoiceBatchApproval>=>{if(!ctx||!isTypeContextCurrent(ctx)||ctx.activeRole!==item.activeRole)throw Error('The original account, role and scope are required.');const key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ctx.ownerIdentity))))).map(x=>x.toString(16).padStart(2,'0')).join('');if(key!==item.ownerKey||!isTypeContextCurrent(ctx))throw Error('The original account, role and scope are required.');const approval=await invoiceBatchApprovals.run(item.operation,item.engagementId,ctx,true);if(!('batchId' in approval))throw Error('The original decision receipt is unavailable.');return approval;};
