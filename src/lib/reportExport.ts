import { adminService, allocationService, clientService, employeeService, projectService, timesheetService } from '../services/api';
import { downloadCsv } from './csv';

import { productConfig } from '../config/productConfig';
import { term, termPlural, termPluralTitle, termTitle } from '../config/terminology';
import { getOrganizationScope } from '../services/apiClient';
import type { OrganizationScope } from '../services/apiClient';
const matchesScope = (expected: OrganizationScope | null, current: OrganizationScope | null) => (
  expected?.organizationId === current?.organizationId
  && expected?.legalEntityId === current?.legalEntityId
);
export type CsvExportOutcome = 'completed' | 'completed-original-scope' | 'cancelled' | 'history-unconfirmed';
export interface ReportExportOption {
  id: string;
  title: string;
  description: string;
  fileName: string;
  category: 'Workforce' | 'Delivery' | 'Planning' | 'Time' | 'Governance';
}

export const getReportExportOptions = (): ReportExportOption[] => [
  { id: 'master_emp', title: `${termTitle('employee')} Master Export`, description: `${termPluralTitle('employee')}, reporting ${termPlural('manager')}, ${termPlural('regionalOwner')}, capacity, and identity placeholders.`, fileName: 'employees.csv', category: 'Workforce' },
  { id: 'master_client', title: 'Client Master Export', description: `Client ownership, industry, status, and ${productConfig.terminology.regionalOwner} scope.`, fileName: 'clients.csv', category: 'Delivery' },
  { id: 'master_prj', title: `${termTitle('project')} Master Export`, description: `${termPluralTitle('project')}, clients, ${termPlural('manager')}, dates, status, and ${term('engagement')} attributes.`, fileName: 'projects.csv', category: 'Delivery' },
  { id: 'util_report', title: 'Utilization Analysis', description: `Planned and actual utilization summary by ${term('employee')}.`, fileName: 'utilization-report.csv', category: 'Planning' },
  { id: 'timesheet_logs', title: `${termTitle('worklog')} Audit Export`, description: `${termTitle('worklog')} status, entries, work type, and approval evidence.`, fileName: 'timesheets.csv', category: 'Time' },
  { id: 'alloc_matrix', title: 'Allocation Matrix', description: `${termTitle('employee')}-${term('project')} assignments, allocation percentages, and effective dates.`, fileName: 'allocations.csv', category: 'Planning' },
  { id: 'system_audit', title: 'Full Traceability Audit', description: 'Audit events across master data, reports, imports, exports, and governance.', fileName: 'audit-logs.csv', category: 'Governance' },
];
export const reportExportOptions = getReportExportOptions();

export const downloadAuditedCsv = async (
  fileName: string,
  rows: object[],
  channel: string,
  status: 'Success' | 'Partial' | 'Failed' = 'Success',
  expectedScope: OrganizationScope | null = getOrganizationScope(),
): Promise<CsvExportOutcome> => {
  if (!matchesScope(expectedScope, getOrganizationScope())) return 'cancelled';
  downloadCsv(fileName, rows);

  try {
    await adminService.saveImportExportLog({
      operation: 'Export',
      channel,
      fileName,
      status,
      totalRows: rows.length,
      validRows: status === 'Failed' ? 0 : rows.length,
      errorRows: status === 'Failed' ? rows.length : 0,
    }, expectedScope, true);
  } catch {
    // The browser download already started. A failed or scope-invalidated history
    // or audit write must not be reported as though the file was cancelled.
    return 'history-unconfirmed';
  }
  return matchesScope(expectedScope, getOrganizationScope()) ? 'completed' : 'completed-original-scope';
};

export const downloadReportExport = async (id: string) => {
  const expectedScope = getOrganizationScope();
  const option = getReportExportOptions().find(item => item.id === id);
  if (!option) throw new Error(`Unknown report export: ${id}`);

  let rows: object[];
  if (id === 'master_emp') {
    rows = (await employeeService.getAll()).map(e => ({ ...e, mappedCountryDirectorIds: e.mappedCountryDirectorIds.join('|') }));
  } else if (id === 'master_client') {
    rows = (await clientService.getAll()).map(client => ({ ...client, countryDirectorIds: client.countryDirectorIds.join('|') }));
  } else if (id === 'master_prj') {
    rows = await projectService.getAll();
  } else if (id === 'timesheet_logs') {
    rows = (await timesheetService.getAll()).map(t => ({ ...t, entries: JSON.stringify(t.entries) }));
  } else if (id === 'alloc_matrix') {
    rows = await allocationService.getAll();
  } else if (id === 'system_audit') {
    rows = await adminService.getAuditLogs();
  } else {
    rows = (await employeeService.getAll()).map(e => ({
      employeeId: e.employeeId,
      name: e.name,
      department: e.department,
      country: e.country,
      plannedUtilization: e.plannedUtilization,
      actualUtilization: e.actualUtilization,
      activeProjectCount: e.activeProjectCount,
      status: e.status,
    }));
  }

  const brand = productConfig.reportBrand.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  const fileName = brand ? brand + '-' + option.fileName : option.fileName;
  return downloadAuditedCsv(fileName, rows, option.title, 'Success', expectedScope);
};
