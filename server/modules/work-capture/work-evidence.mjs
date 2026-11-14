import {z} from 'zod';
import {normalizeEvidenceUrl, evidenceUrlIsValid} from '../../../shared/work-evidence.mjs';
import {WorkPolicyError} from './assignment-work-policy.mjs';

export const evidenceUrlInput = z.union([z.string(), z.null()])
  .refine(evidenceUrlIsValid, 'Use an absolute HTTP or HTTPS evidence URL of at most 2048 characters without embedded credentials.')
  .transform(normalizeEvidenceUrl).optional();

const key = entry => JSON.stringify([String(entry.work_date).slice(0,10),entry.work_type,
  entry.work_type === 'Project Work' ? entry.project_id || null : entry.client_name || null,entry.category || null]);

// Run under the existing scope/header locks, before any replacement. An omitted
// field preserves a uniquely matched link. Ambiguous legacy replacements fail
// rather than silently erase evidence; explicit fields acknowledge replacement.
export const resolveWorkEvidenceReplacement = async (client, timesheetId, entries) => {
  const prior = timesheetId ? (await client.query('select *,work_date::text from timesheet_entries where timesheet_id=$1 order by id',[timesheetId])).rows : [];
  const omitted = entries.some(entry => entry.evidence_url === undefined);
  if (omitted && prior.some(old => old.evidence_url && !entries.some(entry => key(entry) === key(old))))
    throw new WorkPolicyError('WORK_EVIDENCE_REPLACEMENT_CONFLICT','Reload evidence and send explicit evidence URLs or explicit clears for a complete replacement.',409);
  return entries.map(entry => {
    if (entry.evidence_url !== undefined) return entry;
    const matches = prior.filter(old => key(old) === key(entry));
    const incoming = entries.filter(next => key(next) === key(entry));
    if (matches.some(old => old.evidence_url) && (matches.length !== 1 || incoming.length !== 1))
      throw new WorkPolicyError('WORK_EVIDENCE_REPLACEMENT_CONFLICT','Evidence cannot be matched uniquely. Reload and send explicit evidence URLs or explicit clears.',409);
    return {...entry,evidence_url:matches[0]?.evidence_url || null};
  });
};

export const readWorkEvidenceAudit = async (client,timesheetId) => timesheetId
  ? (await client.query('select id,evidence_url from timesheet_entries where timesheet_id=$1 order by id',[timesheetId])).rows
  : [];
