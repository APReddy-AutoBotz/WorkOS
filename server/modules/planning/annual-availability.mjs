import {calculateWorkerCapacity} from './capacity-resolver.mjs';
import {loadCapacitySourceBatch} from './worker-capacity-service.mjs';

const unavailable = Object.freeze({hours:null,percent:null,leaveDays:null,holidayDays:null});

export async function annualPlanningAvailability(client,req,workers,reportDate) {
  const year = reportDate.slice(0,4);
  const startsOn = year + '-01-01', endsOn = year + '-12-31';
  const sources = await loadCapacitySourceBatch(client,req,workers,startsOn,endsOn);
  const availability = new Map();
  for (const [id,source] of sources) {
    availability.set(id,unavailable);
    if (!source.profiles.length || source.limitExceeded) continue;
    const {status,totals,days} = calculateWorkerCapacity(source,startsOn,endsOn);
    if (status !== 'available') continue;
    const scheduled = Number(totals.scheduledHoursExact), hours = Number(totals.availableHoursExact);
    let leaveDays = 0, holidayDays = 0;
    for (const day of days) {
      const scheduledHours = Number(day.scheduledHoursExact);
      if (scheduledHours > 0) {
        leaveDays += Number(day.leaveReductionHoursExact) / scheduledHours;
        if (Number(day.holidayReductionHoursExact) > 0) holidayDays++;
      }
    }
    availability.set(id,{hours,percent:scheduled ? Math.round(1000*hours/scheduled)/10 : null,
      leaveDays:Math.round(leaveDays*1e6)/1e6,holidayDays});
  }
  return availability;
}
