import {compareHours, decimalQuantity, formatQuantity, sumHours} from '../../../shared/work-hours.mjs';

function difference(left, right) {
  if (compareHours(left,right)<=0) return '0';
  const a=decimalQuantity(left), b=decimalQuantity(right);
  const scale=Math.max(a.scale,b.scale);
  return formatQuantity({scale,units:a.units*10n**BigInt(scale-a.scale)-b.units*10n**BigInt(scale-b.scale)});
}

// Input periods are ordered and non-overlapping by the contract version constraint.
export function retainerBalances(periods, approved, policy, today, effectiveFrom) {
  const includeNonBillable=policy==='all_expire' || policy==='all_rollover';
  const rollover=policy==='all_rollover' || policy==='billable_rollover';
  let carriedIn='0';
  return approved.map((row,i)=>{
    if (row.startsOn>today || row.startsOn<effectiveFrom) return row;
    const consumed=includeNonBillable ? sumHours([row.billableHours,row.nonBillableHours]) : row.billableHours;
    const available=sumHours([periods[i].includedHours,carriedIn]);
    const unused=difference(available,consumed);
    const closed=row.endsOn<today;
    const carriedOut=closed && rollover && i+1<periods.length ? unused : '0';
    const capacity={carriedIn,consumed,remaining:closed?'0':unused,overage:difference(consumed,available),
      carriedOut,expired:closed ? difference(unused,carriedOut) : '0'};
    carriedIn=carriedOut;
    return {...row,capacity};
  });
}
