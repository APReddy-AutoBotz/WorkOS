import {randomUUID} from 'node:crypto';
import {invoiceExportRecipients,renderInvoiceExportNotice,validInvoiceExportNotificationPolicy} from '../../../shared/invoice-export-notification.mjs';
// Local development implementation; not mounted or invoked until the migration
// and full protected-event/inbox acceptance are complete. No external delivery.
export const currentInvoiceNoticePolicy=async(c,b)=>{
 const policy=(await c.query("select * from invoice_export_notice_policies where organization_id=$1 and legal_entity_id=$2 and engagement_id=$3 and effective_from<=(clock_timestamp() at time zone 'UTC')::date order by effective_from desc,sequence desc limit 1 for share",[b.organization_id,b.legal_entity_id,b.engagement_id])).rows[0];
 if(!policy||!validInvoiceExportNotificationPolicy(policy.definition))throw Object.assign(Error('Explicit current invoice notification configuration is required.'),{statusCode:409,code:'INVOICE_NOTICE_POLICY'});
 return policy;
};
export const emitInvoiceExportNotice=async(c,r,{batch,policy,resultId,kind})=>{
 if(!['artifact','failure'].includes(kind)||!validInvoiceExportNotificationPolicy(policy.definition))throw new TypeError('Exact invoice export event is required.');
 const key=kind==='artifact'?'invoice_batch.exported_or_billed_confirmed':'invoice_batch.export_failed',cls=kind==='artifact'?'INFORMATIONAL':'OPERATIONAL_CRITICAL',eventId=randomUUID(),p=policy.definition,notice=renderInvoiceExportNotice(p,key,batch.id),relationships=invoiceExportRecipients(key,{userId:batch.owner_user_id,role:batch.owner_role},p);
 await c.query("select set_config('workos.invoice_notice_event_context',$1,true)",[JSON.stringify({eventId,batchId:batch.id,policyId:policy.id,resultId,kind,actorId:r.user.sub,activeRole:r.user.activeRole,operationId:r.operationId,organizationId:batch.organization_id,legalEntityId:batch.legal_entity_id})]);
 await c.query('savepoint invoice_export_notice_producer');
 try{
 await c.query('insert into invoice_export_notice_events(id,batch_id,policy_id,artifact_id,failure_id,event_key,policy_class,operation_id,locale,title,body)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[eventId,batch.id,policy.id,kind==='artifact'?resultId:null,kind==='failure'?resultId:null,key,cls,r.operationId,p.locale,notice.title,notice.body]);
 // The route is an internal durable outbox identity. No external adapter runs.
 // Store it outside the recipient savepoint so incomplete in-app delivery cannot
 // silently erase evidence of a required operational route.
 let routeBlocked=false;if(kind==='failure'){routeBlocked=!(await c.query('select invoice_alert_route_current($1,$2,$3) current',[policy.route_id,batch.organization_id,batch.legal_entity_id])).rows[0].current;await c.query('insert into invoice_export_alert_outbox(id,event_id,route_id,status)values($1,$2,$3,$4)',[randomUUID(),eventId,policy.route_id,'Pending']);}
 await c.query('savepoint invoice_export_notice_recipients');
 let deliveryFailed=false;try{
  for(const item of relationships){const preference=(await c.query('select n.in_app from notification_preferences n join users u on u.employee_record_id=n.employee_id where u.id=$1 and n.event_type=$2',[item.userId,key])).rows[0],decision=kind==='failure'?'Required':!p.completionInApp?'SuppressedPolicy':preference?.in_app===false?'SuppressedPreference':'Enabled',inApp=['Required','Enabled'].includes(decision),recipientId=randomUUID();await c.query('insert into invoice_export_notice_recipients(id,event_id,user_id,reasons,in_app,channel_decision)values($1,$2,$3,$4,$5,$6)',[recipientId,eventId,item.userId,item.reasons,inApp,decision]);if(inApp)await c.query("insert into invoice_export_notice_deliveries(id,recipient_id,channel,status,attempt)values($1,$2,'InApp','Delivered',1)",[randomUUID(),recipientId]);}
  await c.query('release savepoint invoice_export_notice_recipients');
 }catch(e){deliveryFailed=true;await c.query('rollback to savepoint invoice_export_notice_recipients');await c.query('release savepoint invoice_export_notice_recipients');await c.query("insert into invoice_export_notice_failures(id,event_id,code)values($1,$2,'NOTIFICATION_PERSISTENCE_UNAVAILABLE')",[randomUUID(),eventId]);}
 if(routeBlocked&&!deliveryFailed)await c.query("insert into invoice_export_notice_failures(id,event_id,code)values($1,$2,'NOTIFICATION_PERSISTENCE_UNAVAILABLE')",[randomUUID(),eventId]);
 await c.query('release savepoint invoice_export_notice_producer');return eventId;
 }catch(e){await c.query('rollback to savepoint invoice_export_notice_producer');await c.query('release savepoint invoice_export_notice_producer');await c.query("insert into invoice_export_notice_producer_failures(id,batch_id,policy_id,artifact_id,failure_id,operation_id,code)values($1,$2,$3,$4,$5,$6,'NOTIFICATION_EVENT_UNAVAILABLE')",[randomUUID(),batch.id,policy.id,kind==='artifact'?resultId:null,kind==='failure'?resultId:null,r.operationId]);return null;}
};
