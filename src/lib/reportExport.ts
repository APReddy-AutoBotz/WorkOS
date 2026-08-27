import { adminService, allocationService, clientService, employeeService, projectService, timesheetService } from '../services/api';
import { downloadCsv } from './csv';

import { productConfig } from '../config/productConfig';
export interface ReportExportOption {
  id: string;
  title: string;
  description: string;
  fileName: string;
  category: 'Workforce' | 'Delivery' | 'Planning' | 'Time' | 'Governance';
}

export const reportExportOptions: ReportExportOption[] = [
  { id: 'master_emp', title: 'Employee Master Export', description: 'Employees, reporting lines, CD mappings, capacity, and identity placeholders.', fileName: 'employees.csv', category: 'Workforce' },
  { id: 'master_client', title: 'Client Master Export', description: `Client ownership, industry, status, and ${productConfig.terminology.regionalOwner} scope.`, fileName: 'clients.csv', category: 'Delivery' },
  { id: 'master_prj', title: 'Project Master Export', description: 'Projects, clients, managers, dates, status, and delivery attributes.', fileName: 'projects.csv', category: 'Delivery' },
  { id: 'util_report', title: 'Utilization Analysis', description: 'Planned and actual utilization summary by employee.', fileName: 'utilization-report.csv', category: 'Planning' },
  { id: 'timesheet_logs', title: 'Timesheet Audit Export', description: 'Timesheet status, entries, work type, and approval evidence.', fileName: 'timesheets.csv', category: 'Time' },
  { id: 'alloc_matrix', title: 'Allocation Matrix', description: 'Employee-project assignments, allocation percentages, and effective dates.', fileName: 'allocations.csv', category: 'Planning' },
  { id: 'system_audit', title: 'Full Traceability Audit', description: 'Audit events across master data, reports, imports, exports, and governance.', fileName: 'audit-logs.csv', category: 'Governance' },
];

export const downloadAuditedCsv = async (
  fileName: string,
  rows: object[],
  channel: string,
  status: 'Success' | 'Partial' | 'Failed' = 'Success',
) => {
  downloadCsv(fileName, rows);

  await adminService.saveImportExportLog({
    operation: 'Export',
    channel,
    fileName,
    status,
    totalRows: rows.length,
    validRows: status === 'Failed' ? 0 : rows.length,
    errorRows: status === 'Failed' ? rows.length : 0,
  });
};

export const downloadReportExport = async (id: string) => {
  const option = reportExportOptions.find(item => item.id === id);
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

  await downloadAuditedCsv(option.fileName, rows, option.title);
};
