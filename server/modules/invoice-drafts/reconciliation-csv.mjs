import {capacityCanonical,capacityHash} from '../planning/worker-capacity-service.mjs';

export const RECONCILIATION_VERSION = 'workos.tm-reconciliation/1';
export const reconciliationToken = (scope,report) => capacityHash(capacityCanonical({
  version:RECONCILIATION_VERSION,scope,engagementId:report.engagementId,items:report.items,
  missingEvents:report.missingEvents,totals:report.totals,controls:report.controls,exceptionCount:report.exceptionCount,
}));

// Escape spreadsheet formulas even when a value begins with whitespace or a tab.
const cell = value => {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = "'"+text;
  return '"'+text.replaceAll('"','""')+'"';
};
export const reconciliationCsv = (scope,report,token) => {
  const fields = ['record_type','report_version','organization_id','legal_entity_id','engagement_id','as_of_utc','source_token','currency','boundary_or_status','count','amount','item_id','event_id','snapshot_id','approval_id','decision_id','batch_id','line_id','batch_state','artifact_id','artifact_sha256','manual_confirmation_id','control_ok'];
  const base = [RECONCILIATION_VERSION,scope.organizationId,scope.legalEntityId,report.engagementId,new Date(report.asOf).toISOString(),token];
  const encode = values => [...values,...Array(fields.length-values.length).fill('')].map(cell).join(',');
  const lines = [encode(fields),encode(['REPORT',...base])];
  for (const control of report.controls) lines.push(encode(['CONTROL',...base,control.currency,control.boundary,control.lineCount,control.amount]));
  for (const item of report.items) lines.push(encode(['ITEM',...base,item.currency,item.status,1,item.amount,item.itemId,item.eventId,item.snapshotId,item.eligibilityApprovalId,item.eligibilityDecisionId,item.batchId,item.lineId,item.batchState,item.artifactId,item.artifactHash,item.confirmationId,item.controlOk]));
  for (const item of report.items) for (const line of item.history) lines.push(encode(['HISTORY',...base,line.currency,'HISTORICAL_RELEASED_LINE',1,line.amount,item.itemId,item.eventId,item.snapshotId,item.eligibilityApprovalId,item.eligibilityDecisionId,line.batchId,line.lineId,line.batchState,'','','',line.matches]));
  return lines.join('\r\n')+'\r\n';
};
