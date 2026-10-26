import {validCapacityRange} from './worker-capacity.mjs';
import {validCapabilityDate} from './workforce-capabilities.mjs';
export const OWN_WORKSPACE_VERSION='own-workspace/1';
export const OWN_WORKSPACE_PAGE_SIZE=20;
export const OWN_WORKSPACE_REQUIRED=['employee_workspace.view','employees.view'];
export const ownWorkspaceSelection=(startsOn,endsOn)=>validCapacityRange(startsOn,endsOn)?{startsOn,endsOn}:null;
export const ownLeaveCursor=v=>typeof v==='string'&&v.length<=4011&&v[10]==='|'&&validCapabilityDate(v.slice(0,10))&&v.slice(11).length>0;
export const ownBalanceCursor=v=>typeof v==='string'&&v.length<=4005&&/^[0-9]{4}\|/.test(v)&&Number(v.slice(0,4))>=2000&&Number(v.slice(0,4))<=2100&&v.slice(5).length>0;
