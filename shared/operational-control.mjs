import {validCapacityRange} from './worker-capacity.mjs';
import {nativeCheckpoint,validNativeWindow} from './native-forecast.mjs';
export const OPERATIONAL_CONTROL_VERSION='operational-control/1';
export const OPERATIONAL_PAGE_SIZE=10;
export const OPERATIONAL_PENDING_CAP=5;
export const OPERATIONAL_KINDS=Object.freeze(['Work','Material','Creation','Leave']);
export const OPERATIONAL_REQUIRED=Object.freeze(['employees.view','reports.view_utilization','projects.view','allocations.view']);
export const operationalSelection=(startsOn,endsOn,forecastStartsOn,months)=>{
 if(!validCapacityRange(startsOn,endsOn)||!Number.isInteger(months)||months<1||months>3)throw TypeError('Explicit actual period and existing forecast horizon required');
 let forecastEndsOn;try{forecastEndsOn=nativeCheckpoint(forecastStartsOn,months);}catch{throw TypeError('Explicit forecast date required');}
 if(!validNativeWindow(forecastStartsOn,forecastEndsOn,months))throw TypeError('Unsupported native forecast window');
 return{startsOn,endsOn,forecastStartsOn,forecastEndsOn,months};
};
export const operationalConfidence=row=>[...new Set([
 ...row.actual.reasonCodes.map(r=>'ACTUAL:'+r),...row.actual.capacity.reasonCodes.map(r=>'CAPACITY:'+r),
 ...(row.forecast.sourceReason?['FORECAST:'+row.forecast.sourceReason]:[]),
 ...row.forecast.points.flatMap(p=>[...p.reasonCodes,...p.capacity.reasonCodes].map(r=>'FORECAST:'+r)),
 ...row.pending.filter(d=>d.state!=='available').map(d=>'PENDING_'+d.kind.toUpperCase()+':'+d.state.toUpperCase())
])].sort();
