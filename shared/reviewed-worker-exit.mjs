import {approvalKeys,approvalUuid,approvalHash} from './work-approval.mjs';
import {businessItemId,businessCommandCanonical} from './business-structure.mjs';
import {calendarLabel} from './calendar-authoring.mjs';
export const WORKER_EXIT_VERSION='reviewed-worker-exit/1';
export const workerExitKinds=['active_assignment','pending_approval','open_work','project_owner','direct_report'];
export const workerExitStates=['READY','DEPENDENCIES','HISTORY_DATE','PROFILE_UNAVAILABLE','ALREADY_EXITED'];
export const validWorkerExitCommand=c=>approvalKeys(c,['requestId','employeeId','expectedToken','reason'])&&approvalUuid(c.requestId)&&businessItemId(c.employeeId)&&approvalHash(c.expectedToken)&&calendarLabel(c.reason,500);
export const workerExitCanonical=businessCommandCanonical;
