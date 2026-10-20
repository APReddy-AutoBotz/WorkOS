import type {WorkSubmissionAssurance as Assurance} from '../types';

export const WorkSubmissionAssurance = ({assurance,status}:{assurance?:Assurance;status:string}) => (
  <section aria-label="Work submission assurance" className="my-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
    {assurance ? <>
      <p>Submission {assurance.sequence}: {assurance.entryCount} work entries retained, including {assurance.governedEntryCount} governed entries.</p>
      <p>Policy: {assurance.policyVersion}. Dates, assignment and applicable adopted terms were checked at submission.</p>
      <p>Later term changes do not reprice this evidence. This is not billing eligibility or invoice readiness.</p>
    </> : <p>{['Submitted','Approved','Rejected'].includes(status)
      ? 'No retained submission reference. Existing historical work has not been assigned inferred commercial terms.'
      : 'Saving or submitting checks authoritative worker, assignment and project dates. New submissions retain immutable policy references.'}</p>}
  </section>
);
