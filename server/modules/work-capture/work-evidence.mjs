import {z} from 'zod';
import {normalizeEvidenceUrl, evidenceUrlIsValid} from '../../../shared/work-evidence.mjs';
import {WorkPolicyError} from './assignment-work-policy.mjs';

export const evidenceUrlInput = z.union([z.string(), z.null()])
  .refine(evidenceUrlIsValid, 'Use an absolute HTTP or HTTPS evidence URL of at most 2048 characters without embedded credentials.')
  .transform(normalizeEvidenceUrl).optional();

const key = entry => JSON.stringify([String(entry.work_date).slice(0,10),entry.work_type,
  entry.work_type === 'Project Work' ? entry.project_id || null : entry.client_name || null,entry.category || null]);

// Preserve each optional metadata dimension independently under existing locks.
// A caller that only understands evidence URLs cannot erase later references.
const metadataFields=[
  {field:'evidence_url',code:'WORK_EVIDENCE_REPLACEMENT_CONFLICT',label:'evidence URLs'},
  {field:'work_reference',code:'WORK_REFERENCE_REPLACEMENT_CONFLICT',label:'work references'},
];
export const resolveWorkEntryMetadataReplacement = async (client, timesheetId, entries) => {
  const prior = timesheetId ? (await client.query('select *,work_date::text from timesheet_entries where timesheet_id=$1 order by id',[timesheetId])).rows : [];
  let resolved=entries;
  for(const {field,code,label} of metadataFields){
    const omitted=resolved.some(entry=>entry[field]===undefined);
    if(omitted&&prior.some(old=>old[field]&&!resolved.some(entry=>key(entry)===key(old))))
      throw new WorkPolicyError(code,`Reload ${label} and send explicit values or explicit clears for a complete replacement.`,409);
    resolved=resolved.map(entry=>{
      if(entry[field]!==undefined)return entry;
      const matches=prior.filter(old=>key(old)===key(entry)),incoming=resolved.filter(next=>key(next)===key(entry));
      if(matches.some(old=>old[field])&&(matches.length!==1||incoming.length!==1))
        throw new WorkPolicyError(code,`The ${label} cannot be matched uniquely. Reload and send explicit values or explicit clears.`,409);
      return {...entry,[field]:matches[0]?.[field]||null};
    });
  }
  return resolved;
};
// Retained internal export for existing evidence contract tests/callers.
export const resolveWorkEvidenceReplacement=resolveWorkEntryMetadataReplacement;

export const readWorkEvidenceAudit = async (client,timesheetId) => timesheetId
  ? (await client.query('select id,evidence_url,work_reference from timesheet_entries where timesheet_id=$1 order by id',[timesheetId])).rows
  : [];
