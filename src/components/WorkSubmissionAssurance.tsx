import {SubmissionTiming} from './SubmissionTiming';
import type {WorkSubmissionAssurance as Assurance,DuplicateEntryCheck} from '../types';

export const WorkSubmissionAssurance = ({assurance,status,entryCheck}:{assurance?:Assurance;status:string;entryCheck?:DuplicateEntryCheck}) => (
  <section aria-label="Work submission assurance" className="my-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
    {entryCheck&&entryCheck.groups.length>0 ? <div role="status" aria-label="Identical saved-entry content" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <p className="font-semibold">{entryCheck.groups.length} {entryCheck.groups.length===1?'group':'groups'} of identical saved-entry content {entryCheck.groups.length===1?'needs':'need'} review.</p>
      <p>The saved rows repeat the same context, hours, comment and references. Review them before submitting or approving; they may be intentional splits.</p>
      <ul>{entryCheck.groups.map(group=><li key={group.key} className="break-words">{group.entryIds.length} entries on {group.workDate}, {group.hoursExact}h each{group.clientName?`, ${group.clientName}`:''}{group.category?`, ${group.category}`:''}.</li>)}</ul>
    </div> : null}
    {assurance ? <>
      <SubmissionTiming checks={assurance.submissionTiming} retained/>
      <p>Submission {assurance.sequence}: {assurance.entryCount} work entries retained, including {assurance.governedEntryCount} governed entries.</p>
      {assurance.duplicateCheck ? <p>At submission, {assurance.duplicateCheck.groupCount} identical-entry {assurance.duplicateCheck.groupCount===1?'group was':'groups were'} recorded by the within-header content check.</p> : null}
      <p>Policy: {assurance.policyVersion}. Dates, assignment and applicable adopted terms were checked at submission.</p>
      <p>Later term changes do not reprice this evidence. This is not billing eligibility or invoice readiness.</p>
    </> : <p>{['Submitted','Approved','Rejected'].includes(status)
      ? 'No retained submission reference. Existing historical work has not been assigned inferred commercial terms.'
      : 'Saving or submitting checks authoritative worker, assignment and project dates. New submissions retain immutable policy references.'}</p>}
  </section>
);
