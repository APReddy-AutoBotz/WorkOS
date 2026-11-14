import type {TimesheetEntry} from '../types';
import {canonicalHours,compareHours} from '../../shared/work-hours.mjs';

export const captureCalendarDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

export const canonicalCaptureHourInput = (value: string): string | null => {
  if (value === '') return '0';
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const normalized = (value.startsWith('.') ? `0${value}` : value).replace(/\.$/, '');
  try {
    const quantity = canonicalHours(normalized);
    return compareHours(quantity, '24') <= 0 ? quantity : null;
  } catch { return null; }
};
// Numbers are display previews only. Persistence retains the original exact text.
export const parseCaptureHourInput = (value: string): number | null => {
  const quantity = canonicalCaptureHourInput(value);
  return quantity === null ? null : Number(quantity);
};

// The compatibility grid still displays five days. Never overwrite duplicate
// same-day entries or silently drop weekend/out-of-grid/zero-quantity evidence.
export const hydrateWorkCaptureGrid = (entries: TimesheetEntry[], startsOn: string) => {
  const rows: Array<Record<string, any>> = [];
  const preservedEntries: TimesheetEntry[] = [];
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  for (const entry of entries) {
    const day = (Date.parse(`${entry.date}T00:00:00Z`) - start) / 86400000;
    const quantity=canonicalHours(entry.hoursExact??entry.hours);
    if (!Number.isInteger(day) || day < 0 || day >= 5 || compareHours(quantity,'0') <= 0) {
      preservedEntries.push({...entry}); continue;
    }
    const hours = [0, 0, 0, 0, 0], exactHours=['0','0','0','0','0'], remarks = ['', '', '', '', ''];
    hours[day] = Number(quantity);exactHours[day]=quantity; remarks[day] = entry.remark || '';
    rows.push({id: `retained-${entry.id}`, workType: entry.workType, projectId: entry.projectId,
      projectName: entry.projectName, clientName: entry.clientName, category: entry.category,
      hours, exactHours, remarks, rowRemark: '', billable: entry.billable});
  }
  return {rows, preservedEntries};
};
