import type {CapabilityProfile as Profile} from '../services/workforceCapabilities';
export const CapabilityProfile=({profile}:{profile:Profile})=><div className="space-y-2 break-words">
 <p>Skills: {profile.skills.length===0?'None recorded':profile.skills.map(s=>`${s.skill}${s.proficiency?` (${s.proficiency})`:''}`).join(' · ')}</p>
 <ul aria-label="Recorded certifications">{profile.certifications.map(c=><li key={c.certification}>{c.certification} · {c.validFrom} through {c.noExpiry?'explicitly no expiry':c.validThrough}</li>)}</ul>
 <p className="whitespace-pre-wrap">Availability note: {profile.availabilityNote??'None recorded'}</p>
</div>;
