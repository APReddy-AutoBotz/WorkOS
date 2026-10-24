import {z} from 'zod';
import {WorkPolicyError} from './assignment-work-policy.mjs';

export const CAPTURE_MODES_VERSION='work-capture-modes/1';
export const captureModeInput=z.object({expectedLatestId:z.string().min(1).nullable(),
  enabledModes:z.array(z.enum(['weekly','daily'])).min(1).max(2)
    .refine(modes=>new Set(modes).size===modes.length,'Modes must be distinct.')
    .transform(modes=>['weekly','daily'].filter(mode=>modes.includes(mode))),
}).strict();
export const captureModeView=row=>({id:row.id,sequence:Number(row.sequence),policyVersion:row.policy_version,
  enabledModes:row.enabled_modes,createdAt:row.created_at});
export const captureModeWriteFields={
  expected_write_token:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  capture_mode:z.enum(['weekly','daily']).optional(),
  expected_mode_policy_id:z.string().min(1).nullable().optional(),
};
// Full omission remains the deliberately unconditional legacy API contract.
// A token alone adds CAS without adopting a mode. Mode-aware writes require all
// three fields; explicit expected null means create-only, never unconditional.
export const refineCaptureModeWrite=(input,context)=>{
  if((input.capture_mode!==undefined||input.expected_mode_policy_id!==undefined)
    && (input.capture_mode===undefined||input.expected_mode_policy_id===undefined||input.expected_write_token===undefined))
    context.addIssue({code:'custom',message:'Mode-aware saves require mode, mode-policy version and an explicit expected write token.'});
};
export const loadCaptureMode=async(client,req)=>(await client.query(`select * from work_capture_mode_versions
  where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 1`,
[req.organizationScope.organizationId,req.organizationScope.legalEntityId])).rows[0]||null;
export const assertCaptureModeWrite=async(client,req,input,previous)=>{
  if(input.capture_mode!==undefined){
    const latest=await loadCaptureMode(client,req);
    if(!latest||latest.id!==input.expected_mode_policy_id||!latest.enabled_modes.includes(input.capture_mode))
      throw new WorkPolicyError('WORK_CAPTURE_MODE_CONFLICT','Capture modes changed or this mode is disabled. Reload work before saving.',409);
  }
  if(input.expected_write_token!==undefined){
    const current=previous?(await client.query('select work_capture_write_token($1) token',[previous.id])).rows[0]?.token:null;
    if(current!==input.expected_write_token)
      throw new WorkPolicyError('WORK_CAPTURE_WRITE_CONFLICT','Work changed since it was loaded. Reload before saving.',409);
  }
};
