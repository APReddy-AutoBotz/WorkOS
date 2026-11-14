import type {WorkSourceIdentity as Identity} from '../types';
export const WorkSourceIdentity=({value}:{value?:Identity|null})=>value?<span className="block break-words text-xs text-slate-600">Source identity: {value.namespace} / {value.externalId}. Entered source key; linked work is fixed after capture.</span>:null;
