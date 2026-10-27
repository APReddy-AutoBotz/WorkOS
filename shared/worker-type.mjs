import {approvalKeys,approvalUuid} from './work-approval.mjs';
import {businessItemId,businessCommandCanonical} from './business-structure.mjs';
import {validCapabilityDate} from './workforce-capabilities.mjs';
import {calendarLabel} from './calendar-authoring.mjs';
export const WORKER_TYPE_VERSION='worker-type/1';
export const WORKER_KINDS=['employee','contractor','fixed_term','intern','external_resource'];
export const workerTypeCanonical=businessCommandCanonical;
export const validWorkerTypeLabel=c=>approvalKeys(c,['requestId','kind','expectedLatestId','effectiveFrom','label','reason'])&&approvalUuid(c.requestId)&&WORKER_KINDS.includes(c.kind)&&(c.expectedLatestId===null||approvalUuid(c.expectedLatestId))&&validCapabilityDate(c.effectiveFrom)&&calendarLabel(c.label,150)&&calendarLabel(c.reason,1000);
export const validWorkerTypeAssignment=c=>approvalKeys(c,['requestId','employeeId','expectedLatestId','expectedWorkerToken','effectiveFrom','kind','labelEventId','reason'])&&approvalUuid(c.requestId)&&businessItemId(c.employeeId)&&(c.expectedLatestId===null||approvalUuid(c.expectedLatestId))&&typeof c.expectedWorkerToken==='string'&&/^[a-f0-9]{64}$/.test(c.expectedWorkerToken)&&validCapabilityDate(c.effectiveFrom)&&WORKER_KINDS.includes(c.kind)&&approvalUuid(c.labelEventId)&&calendarLabel(c.reason,1000);
