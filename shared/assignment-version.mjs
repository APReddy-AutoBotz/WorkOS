import {canonicalHours,compareHours,decimalQuantity,formatQuantity} from './work-hours.mjs';
import {validCapabilityDate,capabilityLabel as validCapabilityLabel} from './workforce-capabilities.mjs';
export const ASSIGNMENT_VERSION='assignment-version/1';
export const validAssignmentQuantity=v=>{try{return typeof v==='string'&&v.length<=100&&canonicalHours(v)===v&&compareHours(v,'0')>=0&&compareHours(v,'200')<=0;}catch{return false;}};
export const validAssignmentDefinition=v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v))&&Object.keys(v).sort().join(',')===['role','quantityUnit','quantityExact','startsOn','endsOn','billable','status','comment'].sort().join(',')
 &&(v.role===null||validCapabilityLabel(v.role))&&v.quantityUnit==='percentage'&&validAssignmentQuantity(v.quantityExact)&&validCapabilityDate(v.startsOn)&&validCapabilityDate(v.endsOn)&&v.endsOn>=v.startsOn&&typeof v.billable==='boolean'&&['Active','Paused','Completed'].includes(v.status)
 &&(v.comment===null||typeof v.comment==='string'&&v.comment.length>0&&v.comment.length<=3000&&v.comment.trim()===v.comment&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v.comment));
export const assignmentActivePercentage=(snapshot,date)=>snapshot.status==='Active'&&snapshot.startsOn<=date&&date<=snapshot.endsOn?snapshot.quantityExact:'0';

export const validFixedHours = value => {
 try {
  return typeof value === 'string' && value.length <= 100 && canonicalHours(value) === value;
 } catch {
  return false;
 }
};

// Input days are the ordered, complete assignment range from the capacity service.
export const distributeFixedHours = (hours, days) => {
 if (!validFixedHours(hours)) throw new TypeError('Choose a non-negative decimal hours total.');
 if (!days.length || days.some(day => day.availableHoursExact === null)) return null;
 const weights = days.map(day => decimalQuantity(day.availableHoursExact));
 const weightScale = Math.max(...weights.map(weight => weight.scale));
 const units = weights.map(weight => weight.units * 10n ** BigInt(weightScale - weight.scale));
 const denominator = units.reduce((sum, weight) => sum + weight, 0n);
 const total = decimalQuantity(hours);
 if (!denominator) return total.units ? null : days.map(() => '0');

 // Round cumulative shares so that adjacent days telescope to the exact total.
 const scale = Math.max(6, total.scale);
 const totalUnits = total.units * 10n ** BigInt(scale - total.scale);
 let cumulativeWeight = 0n;
 let previous = 0n;
 return units.map(weight => {
  cumulativeWeight += weight;
  const cumulative = (2n * totalUnits * cumulativeWeight + denominator) / (2n * denominator);
  const share = formatQuantity({units:cumulative - previous, scale});
  previous = cumulative;
  return share;
 });
};
