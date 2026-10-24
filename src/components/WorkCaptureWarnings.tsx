import type {OvertimeWarning} from '../types';
export const WorkCaptureWarnings=({warnings}:{warnings?:OvertimeWarning[]})=>warnings?.length?<section role="status" aria-label="Recorded work threshold warnings" className="my-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm break-words">
 <h2 className="font-semibold">Recorded work exceeds configured standard thresholds</h2>
 <ul>{warnings.map(warning=><li key={JSON.stringify([warning.policyId,warning.periodCode,warning.kind,warning.workDate])}>{warning.kind==='daily'?`Daily threshold ${warning.threshold}h on ${warning.workDate}`:`Weekly threshold ${warning.threshold}h in ${warning.periodCode}`}; treatment: {warning.action==='warn'?'warning':'blocking rule'}.</li>)}</ul>
 <p>All recorded worker hours count across work periods and states. These current checks do not change captured hours, billability or prior approval decisions.</p>
</section>:null;
