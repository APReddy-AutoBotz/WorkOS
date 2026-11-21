import type {TimesheetSummary} from '../types';
import {quoteCsvCell} from '../../shared/csv-cell.mjs';

const headers = ['Employee', 'EmployeeId', 'WeekEnding', 'Status', 'ProjectOrClient', 'WorkType',
  'Category', 'Date', 'Hours', 'Remark', 'ApprovedBy', 'RejectedBy', 'RejectionReason'];

export async function buildTimesheetCsv(timesheets: TimesheetSummary[], signal: AbortSignal) {
  const chunks: BlobPart[] = [headers.map(quoteCsvCell).join(',')];
  let lines: string[] = [];
  let rowCount = 0;
  let deadline = performance.now() + 8;
  signal.throwIfAborted();
  for (const sheet of timesheets) {
    for (const entry of sheet.entries) {
      const cells = [sheet.employeeName, sheet.employeeId, sheet.weekEnding, sheet.status,
        entry.projectName || entry.clientName || '', entry.workType, entry.category || '', entry.date,
        entry.hours, entry.remark || '', sheet.approvedBy || '', sheet.rejectedBy || '',
        sheet.rejectionReason || sheet.rejectionNote || ''];
      lines.push('\n' + cells.map(quoteCsvCell).join(','));
      rowCount++;
      if (lines.length >= 256 || performance.now() >= deadline) {
        chunks.push(lines.join(''));
        lines = [];
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
        deadline = performance.now() + 8;
      }
    }
  }
  chunks.push(lines.join(''));
  return {blob: new Blob(chunks, {type: 'text/csv;charset=utf-8'}), rowCount};
}
