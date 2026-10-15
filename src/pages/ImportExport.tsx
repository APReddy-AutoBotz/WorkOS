import { useEffect, useRef, useState } from 'react';
import { ImportHistoryPanel } from '../components/imports/ImportHistoryPanel';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import {
  Upload,
  Download,
  FileText,
  ShieldCheck,
  Search,
  Filter
} from 'lucide-react';
import { cn } from '../lib/utils';
import { allocationService, clientService, employeeService, projectService, timesheetService, adminService } from '../services/api';
import { Employee, Project, Allocation, ImportExportLog, Client, TimesheetSummary, WorkType } from '../types';
import { downloadAuditedCsv, downloadReportExport, getReportExportOptions, type CsvExportOutcome } from '../lib/reportExport';
import { attachPreflightSourceIdentifiers } from '../lib/importErrorProvenance';
import { filterAcceptedImportRows, redactCredentialEchoes } from '../lib/importOperation';
import { beginTrackedExport, consumeExportScopeSwitchNotice, EXPORT_SCOPE_SWITCH_NOTICE, listenForExportScopeSwitch } from '../lib/exportScopeNotice';
import { termPluralTitle, termTitle } from '../config/terminology';
import { getOrganizationScope, type OrganizationScope } from '../services/apiClient';

type ImportChannel = 'employees' | 'clients' | 'projects' | 'allocations' | 'timesheets';
type CsvRow = Record<string, string>;
type ImportErrorRow = {
  rowNumber: number;
  field?: string;
  message: string;
  sourceIdentifier?: string | null;
};
type PendingImport = {
  id: ImportChannel;
  scope: OrganizationScope | null;
  scopeKey: string | null;
  title: string;
  fileName: string;
  rows: CsvRow[];
  validRows: CsvRow[];
  errors: ImportErrorRow[];
  totalRows: number;
  versionedOperation?: {
    schemaVersion: string;
    dryRunKey: string;
    applyKey: string;
    validationState: 'checking' | 'failed' | 'complete';
    requiresNewImport?: boolean;
  };
  employeeImportOperation?: {
    schemaVersion: 'employee-master/1';
    applyKey: string;
    requiresNewImport?: boolean;
  };
};

const getImportOptions = (): Array<{ id: ImportChannel; title: string; description: string; icon: typeof FileText }> => [
  { id: 'employees', title: `${termTitle('employee')} Master`, description: `Bulk onboard or update ${termPluralTitle('employee').toLowerCase()}, skills, and mapping.`, icon: FileText },
  { id: 'clients', title: 'Client Master', description: 'Bulk create or update clients, industries, and director scope.', icon: FileText },
  { id: 'projects', title: `${termTitle('project')} Master`, description: `Batch create ${termPluralTitle('project').toLowerCase()}, ${termPluralTitle('manager').toLowerCase()}, clients, and timelines.`, icon: FileText },
  { id: 'allocations', title: 'Allocation Control', description: 'Validate assignment matrix and percentage loads.', icon: FileText },
  { id: 'timesheets', title: `${termTitle('worklog')} Import`, description: `Bulk load weekly time entries with ${termTitle('employee').toLowerCase()}, ${termTitle('project').toLowerCase()}, and date validation.`, icon: FileText },
];

const employeeStatuses: Employee['status'][] = ['Active', 'On Leave', 'Exited'];
const projectStatuses: Project['status'][] = ['Proposed', 'Active', 'On Hold', 'Completed'];
const allocationStatuses: Allocation['status'][] = ['Active', 'Paused', 'Completed'];
const clientStatuses: Client['status'][] = ['Active', 'Inactive'];
const timesheetStatuses: TimesheetSummary['status'][] = ['Draft', 'Submitted', 'Approved', 'Rejected'];
const workTypes: WorkType[] = ['Project Work', 'Client Misc Task'];

const requiredImportHeaders: Record<ImportChannel, string[]> = {
  employees: ['employeeId', 'name', 'email', 'designation', 'department', 'country', 'region', 'businessUnit', 'reportingManagerId', 'primaryCountryDirectorId', 'mappedCountryDirectorIds', 'utilizationEligible', 'joiningDate', 'exitDate', 'standardWeeklyHours', 'capacityType', 'contractType', 'entraObjectId', 'teamsUserId', 'roles', 'initialPassword', 'status'],
  clients: ['id', 'name', 'industry', 'accountOwnerId', 'countryDirectorIds', 'status'],
  projects: ['projectCode', 'name', 'clientId', 'client', 'managerId', 'startDate', 'endDate', 'status', 'billable', 'projectType', 'country', 'notes'],
  allocations: ['id', 'employeeId', 'projectId', 'roleOnProject', 'percentage', 'startDate', 'endDate', 'billable', 'status', 'comments'],
  timesheets: ['employeeId', 'weekEnding', 'workType', 'projectId', 'clientName', 'category', 'date', 'hours', 'remark', 'billable', 'status', 'rejectionReason'],
};
const versionedImportSchemas: Partial<Record<ImportChannel, string>> = {
  projects: 'project-master/1',
  clients: 'client-master/1',
  allocations: 'allocation-control/1',
  timesheets: 'timesheet-import/1',
};

const orderImportRow = (id: ImportChannel, row: Record<string, unknown>) => {
  return Object.fromEntries(requiredImportHeaders[id].map(header => [header, row[header] ?? '']));
};

const parseStrictIsoDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
};
const isValidDate = (value: string) => parseStrictIsoDate(value) !== null;
const isDateOrderValid = (startDate: string, endDate: string) => {
  const start = parseStrictIsoDate(startDate);
  const end = parseStrictIsoDate(endDate);
  return Boolean(start && end && end.getTime() >= start.getTime());
};
const currentImportScopeKey = () => {
  const scope = getOrganizationScope();
  return scope ? JSON.stringify([scope.organizationId, scope.legalEntityId]) : null;
};
const IMPORT_APPLY_SCOPE_SWITCH_NOTICE_KEY = 'workos_import_apply_scope_switch_notice';
const IMPORT_APPLY_SCOPE_SWITCH_NOTICE_MS = 60_000;
const IMPORT_APPLY_SCOPE_SWITCH_NOTICE = 'The previous-scope import apply may have completed. Switch back to the original scope and check Import History before retrying.';
const readScopeSwitchNotice = (key: string, noticeText: string) => {
  try {
    const serializedNotice = sessionStorage.getItem(key);
    if (!serializedNotice) return '';
    sessionStorage.removeItem(key);
    const notice = JSON.parse(serializedNotice) as { expiresAt?: number };
    return typeof notice.expiresAt === 'number' && notice.expiresAt >= Date.now() ? noticeText : '';
  } catch {
    return '';
  }
};
const sameOrganizationScope = (expected: OrganizationScope | null, current: OrganizationScope | null) => (
  expected?.organizationId === current?.organizationId
  && expected?.legalEntityId === current?.legalEntityId
);
const csvExportNotice = (outcome: CsvExportOutcome, scopeChanged = false) => {
  if (outcome === 'cancelled') return 'The organization or legal-entity scope changed before the export started. No file was downloaded; retry it in the current scope.';
  if (outcome === 'history-unconfirmed') return 'The export file may have downloaded, but its history or audit could not be confirmed. Check Import History in the original scope before retrying.';
  if (outcome === 'completed-original-scope' || scopeChanged) return 'The export was downloaded and recorded under the original organization/entity scope. Switch back to that scope to confirm its history before retrying.';
  return '';
};

export const ImportExport = () => {
  const importOptions = getImportOptions();
  const exportOptions = getReportExportOptions().map(option => ({ ...option, filters: [option.category, 'Scope'], formats: ['CSV'] }));
  const [activeTab, setActiveTab] = useState<'import' | 'export'>('import');
  const [lastResult, setLastResult] = useState<string>('');
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const importRequestVersion = useRef(0);
  const applyLock = useRef(false);
  const activeExportCount = useRef(0);
  useEffect(() => {
    const notices = [
      readScopeSwitchNotice(IMPORT_APPLY_SCOPE_SWITCH_NOTICE_KEY, IMPORT_APPLY_SCOPE_SWITCH_NOTICE),
      consumeExportScopeSwitchNotice(),
    ].filter(Boolean);
    if (notices.length) setLastResult(notices.join(' '));
  }, []);
  useEffect(() => listenForExportScopeSwitch(), []);
  useEffect(() => {
    const persistPendingApplyScopeSwitchNotice = () => {
      if (!applyLock.current) return;
      try {
        sessionStorage.setItem(IMPORT_APPLY_SCOPE_SWITCH_NOTICE_KEY, JSON.stringify({
          expiresAt: Date.now() + IMPORT_APPLY_SCOPE_SWITCH_NOTICE_MS,
        }));
      } catch {
        // The current page still reports the in-flight apply if storage is unavailable.
      }
    };
    const clearPendingImportForScopeChange = () => {
      const applyWasInFlight = applyLock.current;
      const exportWasInFlight = activeExportCount.current > 0;
      if (applyWasInFlight) {
        try {
          sessionStorage.setItem(IMPORT_APPLY_SCOPE_SWITCH_NOTICE_KEY, JSON.stringify({
            expiresAt: Date.now() + IMPORT_APPLY_SCOPE_SWITCH_NOTICE_MS,
          }));
        } catch {
          // The in-page warning below still applies if session storage is unavailable.
        }
      }
      importRequestVersion.current += 1;
      setPendingImport(null);
      setIsPreviewing(false);
      const scopeNotices: string[] = [];
      if (applyWasInFlight) scopeNotices.push('The organization or legal-entity scope changed while an import apply was in progress. The request may still finish under its original scope, but its result will be hidden. Switch back to that scope and check Import History before retrying.');
      if (exportWasInFlight) scopeNotices.push(EXPORT_SCOPE_SWITCH_NOTICE);
      setLastResult(scopeNotices.length ? scopeNotices.join(' ') : 'Organization or legal-entity scope changed. Choose the CSV again to validate it for the current scope.');
    };
    window.addEventListener('workos:organization-scope-changed', clearPendingImportForScopeChange);
    window.addEventListener('workos:organization-scope-switch-requested', persistPendingApplyScopeSwitchNotice);
    return () => {
      window.removeEventListener('workos:organization-scope-changed', clearPendingImportForScopeChange);
      window.removeEventListener('workos:organization-scope-switch-requested', persistPendingApplyScopeSwitchNotice);
      importRequestVersion.current += 1;
    };
  }, []);
  const refreshHistory = () => setHistoryRevision(value => value + 1);
  const importRequestIsCurrent = (version: number, scopeKey: string | null) => (
    version === importRequestVersion.current && scopeKey === currentImportScopeKey()
  );
  const runVersionedImport = (
    channel: 'projects' | 'clients' | 'allocations' | 'timesheets',
    request: {fileName: string; rows: CsvRow[]; clientErrors: ImportErrorRow[]; totalRows: number; dryRun: boolean; idempotencyKey: string},
    expectedScope: OrganizationScope | null,
  ) => {
    switch (channel) {
      case 'projects': return adminService.runVersionedProjectImport(request, expectedScope);
      case 'clients': return adminService.runVersionedClientImport(request, expectedScope);
      case 'allocations': return adminService.runVersionedAllocationImport(request, expectedScope);
      case 'timesheets': return adminService.runVersionedTimesheetImport(request, expectedScope);
    }
  };

  const downloadCsv = (fileName: string, rows: object[], channel = fileName) => {
    const expectedScope = getOrganizationScope();
    activeExportCount.current += 1;
    const endTrackedExport = beginTrackedExport();
    void downloadAuditedCsv(fileName, rows, channel, 'Success', expectedScope).then(outcome => {
      const notice = csvExportNotice(outcome, !sameOrganizationScope(expectedScope, getOrganizationScope()));
      if (notice) setLastResult(notice);
    }).catch(() => {
      setLastResult('The export file may have downloaded, but its history or audit could not be confirmed. Check Import History in the original scope before retrying.');
    }).finally(() => {
      activeExportCount.current -= 1;
      endTrackedExport();
      refreshHistory();
    });
  };

  const parseCsv = (text: string): { headers: string[]; rows: CsvRow[] } => {
    const trimmed = text.trim();
    if (!trimmed) return { headers: [], rows: [] };
    const [headerLine, ...lines] = trimmed.split(/\r?\n/);
    const splitCsvLine = (line: string) => line
      .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
      .map(value => value.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    const headers = splitCsvLine(headerLine);
    const rows = lines.filter(Boolean).map(line => {
      const values = splitCsvLine(line);
      return headers.reduce<CsvRow>((row, header, index) => {
        row[header] = values[index] || '';
        return row;
      }, {});
    });
    return { headers, rows };
  };

  const addError = (errors: ImportErrorRow[], rowNumber: number, field: string, message: string) => {
    errors.push({ rowNumber, field, message });
  };

  const normalizeImportKey = (value?: string) => (value || '').trim().toLowerCase();

  const validateCsvStructure = (id: ImportChannel, headers: string[], rowCount: number) => {
    const headerSet = new Set(headers.map(header => header.trim()));
    const errors: ImportErrorRow[] = [];
    if (headers.length === 0) {
      addError(errors, 1, 'header', 'CSV header row is required.');
    }
    requiredImportHeaders[id].forEach(header => {
      if (!headerSet.has(header)) addError(errors, 1, 'header', `Missing required column: ${header}.`);
    });
    if (rowCount === 0) {
      addError(errors, 2, 'file', 'CSV must include at least one data row.');
    }
    return errors;
  };

  const getDuplicateKeys = (id: ImportChannel, row: CsvRow): Array<{ field: string; label: string; value: string }> => {
    if (id === 'employees') {
      return [
        { field: 'employeeId', label: 'Employee ID', value: normalizeImportKey(row.employeeId) },
        { field: 'email', label: 'Email', value: normalizeImportKey(row.email) },
      ].filter(item => item.value);
    }
    if (id === 'clients') {
      return [
        { field: 'id', label: 'Client ID', value: normalizeImportKey(row.id) },
        { field: 'name', label: 'Client name', value: normalizeImportKey(row.name) },
      ].filter(item => item.value);
    }
    if (id === 'projects') {
      return [{ field: 'projectCode', label: 'Project code', value: normalizeImportKey(row.projectCode) }].filter(item => item.value);
    }
    if (id === 'allocations') {
      return [{
        field: 'allocationKey',
        label: 'Allocation key',
        value: [row.employeeId, row.projectId, row.startDate, row.endDate].map(normalizeImportKey).join('|'),
      }].filter(item => item.value.replace(/\|/g, ''));
    }
    return [{
      field: 'timesheetEntryKey',
      label: 'Timesheet entry key',
      value: [row.employeeId, row.weekEnding, row.date, row.workType, row.projectId || row.clientName].map(normalizeImportKey).join('|'),
    }].filter(item => item.value.replace(/\|/g, ''));
  };

  const validateRows = async (id: ImportChannel, rows: CsvRow[]) => {
    const errors: ImportErrorRow[] = [];
    const [employees, projects, directors] = await Promise.all([
      employeeService.getAll(),
      projectService.getAll(),
      adminService.getCountryDirectors(),
    ]);
    const employeeIds = new Set(employees.flatMap(employee => [employee.id, employee.employeeId]));
    const projectIds = new Set(projects.flatMap(project => [project.id, project.projectCode]));
    const directorIds = new Set(directors.map(director => director.id));
    const rowsWithErrors = new Set<number>();
    const seenKeys = new Map<string, number>();

    rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const before = errors.length;

      getDuplicateKeys(id, row).forEach(({ field, label, value }) => {
        const key = `${id}:${field}:${value}`;
        const firstRow = seenKeys.get(key);
        if (firstRow) {
          addError(errors, rowNumber, field, `Duplicate ${label} also appears on row ${firstRow}.`);
        } else {
          seenKeys.set(key, rowNumber);
        }
      });

      if (id === 'employees') {
        if (!row.employeeId) addError(errors, rowNumber, 'employeeId', 'Employee ID is required.');
        if (!row.name) addError(errors, rowNumber, 'name', 'Employee name is required.');
        if (!row.email) addError(errors, rowNumber, 'email', 'Email is required.');
        if (row.email && !row.email.includes('@')) addError(errors, rowNumber, 'email', 'Email format is invalid.');
        if (row.reportingManagerId && !employeeIds.has(row.reportingManagerId)) addError(errors, rowNumber, 'reportingManagerId', 'Reporting manager employee record does not exist.');
        if (row.joiningDate && !isValidDate(row.joiningDate)) addError(errors, rowNumber, 'joiningDate', 'Joining date must use YYYY-MM-DD.');
        if (row.exitDate && !isValidDate(row.exitDate)) addError(errors, rowNumber, 'exitDate', 'Exit date must use YYYY-MM-DD.');
        if (row.standardWeeklyHours && (Number.isNaN(Number(row.standardWeeklyHours)) || Number(row.standardWeeklyHours) <= 0 || Number(row.standardWeeklyHours) > 168)) {
          addError(errors, rowNumber, 'standardWeeklyHours', 'Standard weekly hours must be between 1 and 168.');
        }
        if (row.status && !employeeStatuses.includes(row.status as Employee['status'])) {
          addError(errors, rowNumber, 'status', `Status must be one of: ${employeeStatuses.join(', ')}.`);
        }
        if (row.primaryCountryDirectorId && !directorIds.has(row.primaryCountryDirectorId)) {
          addError(errors, rowNumber, 'primaryCountryDirectorId', 'Primary country director does not exist.');
        }
        (row.mappedCountryDirectorIds || '').split('|').filter(Boolean).forEach(cdId => {
          if (!directorIds.has(cdId)) addError(errors, rowNumber, 'mappedCountryDirectorIds', `Country director ${cdId} does not exist.`);
        });
      }

      if (id === 'projects') {
        if (!row.projectCode) addError(errors, rowNumber, 'projectCode', 'Project code is required.');
        if (!row.name) addError(errors, rowNumber, 'name', 'Project name is required.');
        if (!row.client) addError(errors, rowNumber, 'client', 'Client is required.');
        if (!row.managerId) addError(errors, rowNumber, 'managerId', 'Project manager is required.');
        if (row.managerId && !employeeIds.has(row.managerId)) addError(errors, rowNumber, 'managerId', 'Project manager employee record does not exist.');
        if (!row.startDate || !isValidDate(row.startDate)) addError(errors, rowNumber, 'startDate', 'Valid start date is required.');
        if (!row.endDate || !isValidDate(row.endDate)) addError(errors, rowNumber, 'endDate', 'Valid end date is required.');
        if (row.startDate && row.endDate && !isDateOrderValid(row.startDate, row.endDate)) {
          addError(errors, rowNumber, 'endDate', 'End date must be on or after start date.');
        }
        if (row.status && !projectStatuses.includes(row.status as Project['status'])) {
          addError(errors, rowNumber, 'status', `Status must be one of: ${projectStatuses.join(', ')}.`);
        }
      }

      if (id === 'clients') {
        if (!row.name) addError(errors, rowNumber, 'name', 'Client name is required.');
        if (row.status && !clientStatuses.includes(row.status as Client['status'])) {
          addError(errors, rowNumber, 'status', `Status must be one of: ${clientStatuses.join(', ')}.`);
        }
        (row.countryDirectorIds || '').split('|').filter(Boolean).forEach(cdId => {
          if (!directorIds.has(cdId)) addError(errors, rowNumber, 'countryDirectorIds', `Country director ${cdId} does not exist.`);
        });
      }

      if (id === 'allocations') {
        if (!row.employeeId) addError(errors, rowNumber, 'employeeId', 'Employee ID is required.');
        if (row.employeeId && !employeeIds.has(row.employeeId)) addError(errors, rowNumber, 'employeeId', 'Employee does not exist.');
        if (!row.projectId) addError(errors, rowNumber, 'projectId', 'Project ID is required.');
        if (row.projectId && !projectIds.has(row.projectId)) addError(errors, rowNumber, 'projectId', 'Project does not exist.');
        const percentage = Number(row.percentage);
        if (!row.percentage || Number.isNaN(percentage) || percentage <= 0 || percentage > 200) {
          addError(errors, rowNumber, 'percentage', 'Percentage must be a number between 1 and 200.');
        }
        if (!row.startDate || !isValidDate(row.startDate)) addError(errors, rowNumber, 'startDate', 'Valid start date is required.');
        if (!row.endDate || !isValidDate(row.endDate)) addError(errors, rowNumber, 'endDate', 'Valid end date is required.');
        if (row.startDate && row.endDate && !isDateOrderValid(row.startDate, row.endDate)) {
          addError(errors, rowNumber, 'endDate', 'End date must be on or after start date.');
        }
        if (row.status && !allocationStatuses.includes(row.status as Allocation['status'])) {
          addError(errors, rowNumber, 'status', `Status must be one of: ${allocationStatuses.join(', ')}.`);
        }
      }

      if (id === 'timesheets') {
        if (!row.employeeId) addError(errors, rowNumber, 'employeeId', 'Employee ID is required.');
        if (row.employeeId && !employeeIds.has(row.employeeId)) addError(errors, rowNumber, 'employeeId', 'Employee does not exist.');
        if (!row.weekEnding || !isValidDate(row.weekEnding)) addError(errors, rowNumber, 'weekEnding', 'Valid week ending date is required.');
        if (!row.date || !isValidDate(row.date)) addError(errors, rowNumber, 'date', 'Valid work date is required.');
        const hours = Number(row.hours);
        if (!row.hours || Number.isNaN(hours) || hours < 0 || hours > 24) {
          addError(errors, rowNumber, 'hours', 'Hours must be a number between 0 and 24.');
        }
        if (!row.workType || !workTypes.includes(row.workType as WorkType)) {
          addError(errors, rowNumber, 'workType', `Work type must be one of: ${workTypes.join(', ')}.`);
        }
        if (row.workType === 'Project Work') {
          if (!row.projectId) addError(errors, rowNumber, 'projectId', 'Project Work entries require a project.');
          if (row.projectId && !projectIds.has(row.projectId)) addError(errors, rowNumber, 'projectId', 'Project does not exist.');
        }
        if (row.workType === 'Client Misc Task' && !row.clientName) {
          addError(errors, rowNumber, 'clientName', 'Client Misc Task entries require a client name.');
        }
        if (row.status && !timesheetStatuses.includes(row.status as TimesheetSummary['status'])) {
          addError(errors, rowNumber, 'status', `Status must be one of: ${timesheetStatuses.join(', ')}.`);
        }
      }

      if (errors.length > before) rowsWithErrors.add(rowNumber);
    });

    return {
      errors,
      validRows: rows.filter((_, index) => !rowsWithErrors.has(index + 2)),
    };
  };

  const handleExport = async (id: string) => {
    const expectedScope = getOrganizationScope();
    activeExportCount.current += 1;
    const endTrackedExport = beginTrackedExport();
    try {
      const outcome = await downloadReportExport(id);
      const notice = csvExportNotice(outcome, !sameOrganizationScope(expectedScope, getOrganizationScope()));
      if (notice) setLastResult(notice);
    } finally {
      activeExportCount.current -= 1;
      endTrackedExport();
      refreshHistory();
    }
  };

  const handleImport = async (id: ImportChannel, file?: File) => {
    if (!file || applyLock.current) return;
    const requestVersion = ++importRequestVersion.current;
    const scope = getOrganizationScope();
    const scopeKey = scope ? JSON.stringify([scope.organizationId, scope.legalEntityId]) : null;
    const isCurrentRequest = () => importRequestIsCurrent(requestVersion, scopeKey);
    const readLabel = id === 'employees' ? `${termTitle('employee')} Master CSV` : file.name;
    setIsPreviewing(true);
    setPendingImport(null);
    setLastResult(`Reading ${readLabel}…`);
    let csvText: string;
    try {
      csvText = await file.text();
    } catch {
      if (isCurrentRequest()) {
        setIsPreviewing(false);
        setLastResult(`Could not read ${readLabel}. Choose the file again to retry.`);
      }
      return;
    }
    if (!isCurrentRequest()) return;
    const { headers, rows } = parseCsv(csvText);
    const option = importOptions.find(item => item.id === id);
    const employeeCredentials = id === 'employees'
      ? rows.map(row => row.initialPassword).filter((value): value is string => Boolean(value))
      : [];
    const fileName = id === 'employees'
      ? redactCredentialEchoes(file.name, employeeCredentials)
      : file.name;
    const structureErrors = validateCsvStructure(id, headers, rows.length);
    let validationResult: {validRows: CsvRow[]; errors: ImportErrorRow[]};
    try {
      validationResult = structureErrors.length > 0
        ? {validRows: [], errors: []}
        : await validateRows(id, rows);
    } catch {
      if (isCurrentRequest()) {
        setIsPreviewing(false);
        setLastResult(`Could not validate ${fileName}. Check your connection and workspace access, then choose the CSV again.`);
      }
      return;
    }
    if (!isCurrentRequest()) return;
    const validRows = validationResult.validRows;
    const preflightErrors = attachPreflightSourceIdentifiers(id, rows, [...structureErrors, ...validationResult.errors]);
    const errors = id === 'employees'
      ? redactCredentialEchoes(preflightErrors, employeeCredentials)
      : preflightErrors;
    const status: ImportExportLog['status'] = validRows.length === 0 ? 'Failed' : 'Dry Run';
    const schemaVersion = versionedImportSchemas[id] || null;
    const basePending: PendingImport = {
      id, scope, scopeKey, title: option?.title || id, fileName, rows, validRows, errors,
      totalRows: rows.length,
      ...(schemaVersion ? {
        versionedOperation: {
          schemaVersion,
          dryRunKey: crypto.randomUUID(),
          applyKey: crypto.randomUUID(),
          validationState: 'checking' as const,
        },
      } : {}),
      ...(id === 'employees' ? {
        employeeImportOperation: {
          schemaVersion: 'employee-master/1' as const,
          applyKey: crypto.randomUUID(),
        },
      } : {}),
    };
    setPendingImport(basePending);

    if (schemaVersion) {
      setLastResult(`Checking ${fileName} against the server without applying ${option?.title || id} changes…`);
      try {
        const result = await runVersionedImport(id as 'projects' | 'clients' | 'allocations' | 'timesheets', {
          fileName,
          rows: validRows,
          clientErrors: errors,
          totalRows: rows.length,
          dryRun: true,
          idempotencyKey: basePending.versionedOperation!.dryRunKey,
        }, scope);
        if (!isCurrentRequest()) return;
        if (result === null) {
          // Preserve explicit local/demo mode; production fails closed in checkBackend.
          setPendingImport({...basePending, versionedOperation: undefined});
          setLastResult(
            status === 'Failed'
              ? `${option?.title || id} validation failed for ${fileName}. Download the error report and correct the file.`
              : `Dry run complete for ${fileName}: ${validRows.length}/${rows.length} rows are valid. Review errors before applying.`
          );
          await adminService.saveImportExportLog({
            operation: 'Import', channel: option?.title || id, fileName, status,
            totalRows: rows.length, validRows: validRows.length, errorRows: errors.length, errors,
          }, basePending.scope);
          refreshHistory();
          return;
        }
        if (result.schemaVersion !== schemaVersion || result.dryRun !== true || result.status !== 'Dry Run') {
          throw new Error('The server did not confirm the expected versioned dry-run result.');
        }
        const serverErrors = result.errors;
        const serverValidRows = filterAcceptedImportRows(rows, validRows, serverErrors);
        if (serverValidRows.length !== result.validRows) {
          throw new Error('The server validation result did not match the source row mapping.');
        }
        setPendingImport({
          ...basePending,
          validRows: serverValidRows,
          errors: serverErrors,
          versionedOperation: {...basePending.versionedOperation!, validationState: 'complete'},
        });
        setLastResult(`Server dry run complete for ${fileName}: ${serverValidRows.length}/${rows.length} rows are valid. Review saved errors before applying.`);
        refreshHistory();
      } catch (error) {
        if (!isCurrentRequest()) return;
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as {code?: unknown}).code || '')
          : '';
        setPendingImport({
          ...basePending,
          versionedOperation: {
            ...basePending.versionedOperation!,
            validationState: 'failed',
            ...(code === 'IDEMPOTENCY_KEY_REUSED' ? {requiresNewImport: true} : {}),
          },
        });
        setLastResult(code === 'IDEMPOTENCY_KEY_REUSED'
          ? `The validation key for ${fileName} is tied to different data. Choose the CSV again to start a fresh import.`
          : `Server validation did not finish for ${fileName}. Retry validation with this same import operation; no apply request was sent.`);
      } finally {
        if (isCurrentRequest()) setIsPreviewing(false);
      }
      return;
    }

    setLastResult(
      status === 'Failed'
        ? `${option?.title || id} validation failed for ${fileName}. Download the error report and correct the file.`
        : `Dry run complete for ${fileName}: ${validRows.length}/${rows.length} rows are valid. Review errors before applying.`
    );
    void adminService.saveImportExportLog({
      operation: 'Import', channel: option?.title || id, fileName, status,
      totalRows: rows.length, validRows: validRows.length, errorRows: errors.length, errors,
    }, scope).catch(() => {
      if (isCurrentRequest()) setLastResult('Import preflight history could not be saved. Check your connection and workspace access.');
    });
    refreshHistory();
    setIsPreviewing(false);
  };

  const retryVersionedImportDryRun = async () => {
    if (!pendingImport || !pendingImport.versionedOperation
        || !['projects', 'clients', 'allocations', 'timesheets'].includes(pendingImport.id)
        || pendingImport.versionedOperation.validationState !== 'failed' || pendingImport.versionedOperation.requiresNewImport
        || isPreviewing || applyLock.current) return;
    if (pendingImport.scopeKey !== currentImportScopeKey()) {
      importRequestVersion.current += 1;
      setPendingImport(null);
      setIsPreviewing(false);
      setLastResult('Organization or legal-entity scope changed. Choose the CSV again to validate it for the current scope.');
      return;
    }
    const requestVersion = importRequestVersion.current;
    const snapshot = pendingImport;
    const isCurrentRequest = () => importRequestIsCurrent(requestVersion, snapshot.scopeKey);
    setIsPreviewing(true);
    setLastResult(`Retrying server validation for ${snapshot.fileName} with the same import key…`);
    try {
      const result = await runVersionedImport(snapshot.id as 'projects' | 'clients' | 'allocations' | 'timesheets', {
        fileName: snapshot.fileName,
        rows: snapshot.validRows,
        clientErrors: snapshot.errors,
        totalRows: snapshot.totalRows,
        dryRun: true,
        idempotencyKey: snapshot.versionedOperation.dryRunKey,
      }, snapshot.scope);
      if (!isCurrentRequest()) return;
      if (!result || result.schemaVersion !== snapshot.versionedOperation.schemaVersion || result.dryRun !== true || result.status !== 'Dry Run') {
        throw new Error('The server did not confirm the expected versioned dry-run result.');
      }
      const validRows = filterAcceptedImportRows(snapshot.rows, snapshot.validRows, result.errors);
      if (validRows.length !== result.validRows) throw new Error('The server validation result did not match the source row mapping.');
      setPendingImport({
        ...snapshot,
        validRows,
        errors: result.errors,
        versionedOperation: {...snapshot.versionedOperation, validationState: 'complete'},
      });
      setLastResult(`Server dry run complete for ${snapshot.fileName}: ${validRows.length}/${snapshot.totalRows} rows are valid. Review saved errors before applying.`);
      refreshHistory();
    } catch (error) {
      if (!isCurrentRequest()) return;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as {code?: unknown}).code || '')
        : '';
      setPendingImport({
        ...snapshot,
        versionedOperation: {
          ...snapshot.versionedOperation,
          validationState: 'failed',
          ...(code === 'IDEMPOTENCY_KEY_REUSED' ? {requiresNewImport: true} : {}),
        },
      });
      setLastResult(code === 'IDEMPOTENCY_KEY_REUSED'
        ? `The validation key for ${snapshot.fileName} is tied to different data. Choose the CSV again to start a fresh import.`
        : `Server validation still did not finish for ${snapshot.fileName}. You can retry with the same import key.`);
    } finally {
      if (isCurrentRequest()) setIsPreviewing(false);
    }
  };

  const applyPendingImport = async () => {
    if (!pendingImport) return;
    const requestVersion = importRequestVersion.current;
    const scopeKey = pendingImport.scopeKey;
    const isCurrentApply = () => importRequestIsCurrent(requestVersion, scopeKey);
    const reportStaleApplyResponse = () => setLastResult(
      'An import apply response arrived after the scope changed, so its result details are hidden. Switch back to the original scope and check Import History before retrying.'
    );
    if (!isCurrentApply()) {
      importRequestVersion.current += 1;
      setPendingImport(null);
      setLastResult('Organization or legal-entity scope changed. Choose the CSV again to validate it for the current scope.');
      return;
    }
    if (pendingImport.versionedOperation && ['projects', 'clients', 'allocations', 'timesheets'].includes(pendingImport.id)) {
      const operation = pendingImport.versionedOperation;
      if (operation.validationState !== 'complete' || operation.requiresNewImport || applyLock.current) return;
      applyLock.current = true;
      setIsApplying(true);
      try {
        const backendResult = await runVersionedImport(pendingImport.id as 'projects' | 'clients' | 'allocations' | 'timesheets', {
          fileName: pendingImport.fileName,
          rows: pendingImport.validRows,
          clientErrors: pendingImport.errors,
          totalRows: pendingImport.totalRows,
          dryRun: false,
          idempotencyKey: operation.applyKey,
        }, pendingImport.scope);
        if (!isCurrentApply()) {
          if (scopeKey !== currentImportScopeKey()) reportStaleApplyResponse();
          return;
        }
        if (!backendResult || backendResult.schemaVersion !== operation.schemaVersion || backendResult.dryRun !== false) {
          throw new Error('The server did not confirm the expected versioned import apply result.');
        }
        const resultText = backendResult.status === 'Success'
          ? `Applied ${backendResult.validRows} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`
          : `${pendingImport.title} apply finished with ${backendResult.validRows} valid rows and ${backendResult.errorRows} errors for ${pendingImport.fileName}. View saved diagnostic details in Import History.`;
        setLastResult(resultText);
        setPendingImport(null);
        refreshHistory();
      } catch (error) {
        if (!isCurrentApply()) {
          if (scopeKey !== currentImportScopeKey()) reportStaleApplyResponse();
          return;
        }
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as {code?: unknown}).code || '')
          : '';
        if (code === 'IDEMPOTENCY_KEY_REUSED') {
          setPendingImport({...pendingImport, versionedOperation: {...operation, requiresNewImport: true}});
          setLastResult(`The apply key for ${pendingImport.fileName} is tied to different data. Choose the CSV again to start a fresh import.`);
        } else {
          setLastResult(`The apply result for ${pendingImport.fileName} was not confirmed. Retry with the same validated rows and apply key.`);
        }
      } finally {
        applyLock.current = false;
        setIsApplying(false);
      }
      return;
    }
    let saved = 0;

    if (pendingImport.id === 'employees') {
      const operation = pendingImport.employeeImportOperation;
      if (!operation || operation.requiresNewImport || applyLock.current) return;
      applyLock.current = true;
      setIsApplying(true);
      try {
        const backendResult = await adminService.applyEmployeeImport(
          pendingImport.fileName,
          pendingImport.validRows,
          operation.applyKey,
          pendingImport.errors,
          pendingImport.rows.length,
          pendingImport.scope,
        );
        if (!isCurrentApply()) {
          if (scopeKey !== currentImportScopeKey()) reportStaleApplyResponse();
          return;
        }
        if (backendResult) {
          setLastResult(backendResult.replayed
            ? `Confirmed the saved Employee Master result for ${pendingImport.fileName}. This retry replayed the first accepted result and did not change credentials.`
            : `Applied ${backendResult.validRows} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`);
          setPendingImport(null);
          refreshHistory();
          return;
        }
      } catch (error) {
        if (!isCurrentApply()) {
          if (scopeKey !== currentImportScopeKey()) reportStaleApplyResponse();
          return;
        }
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as {code?: unknown}).code || '')
          : '';
        if (code === 'IDEMPOTENCY_KEY_REUSED') {
          setPendingImport({...pendingImport, employeeImportOperation: {...operation, requiresNewImport: true}});
          setLastResult(`The Employee Master key for ${pendingImport.fileName} is tied to different non-credential data. Choose the CSV again to start a new import.`);
        } else {
          setLastResult(`The Employee Master apply result for ${pendingImport.fileName} was not confirmed. Retry with the same import and key; a retry will replay the first accepted result and will not change credentials.`);
        }
        return;
      } finally {
        applyLock.current = false;
        setIsApplying(false);
      }
    }

    if (pendingImport.id === 'clients') {
      const backendResult = await adminService.applyClientImport(pendingImport.fileName, pendingImport.validRows, pendingImport.errors, pendingImport.rows.length, pendingImport.scope);
      if (!isCurrentApply()) return;
      if (backendResult) {
        setLastResult(`Applied ${backendResult.validRows} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`);
        setPendingImport(null);
        refreshHistory();
        return;
      }
    }

    if (pendingImport.id === 'projects') {
      const backendResult = await adminService.applyProjectImport(pendingImport.fileName, pendingImport.validRows, pendingImport.errors, pendingImport.rows.length, pendingImport.scope);
      if (!isCurrentApply()) return;
      if (backendResult) {
        setLastResult(`Applied ${backendResult.validRows} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`);
        setPendingImport(null);
        refreshHistory();
        return;
      }
    }

    if (pendingImport.id === 'allocations') {
      const backendResult = await adminService.applyAllocationImport(pendingImport.fileName, pendingImport.validRows, pendingImport.errors, pendingImport.rows.length, pendingImport.scope);
      if (!isCurrentApply()) return;
      if (backendResult) {
        setLastResult(`Applied ${backendResult.validRows} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`);
        setPendingImport(null);
        refreshHistory();
        return;
      }
    }

    if (pendingImport.id === 'timesheets') {
      const backendResult = await adminService.applyTimesheetImport(pendingImport.fileName, pendingImport.validRows, pendingImport.errors, pendingImport.rows.length, pendingImport.scope);
      if (!isCurrentApply()) return;
      if (backendResult) {
        setLastResult(`Applied ${backendResult.validRows} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`);
        setPendingImport(null);
        refreshHistory();
        return;
      }
    }

    if (pendingImport.id === 'employees') {
      const existing = await employeeService.getAll();
      for (const row of pendingImport.validRows) {
        const current = existing.find(e => e.employeeId === row.employeeId || e.email === row.email);
        const employee: Employee = {
          id: current?.id || `e-${Date.now()}-${saved}`,
          employeeId: row.employeeId,
          name: row.name,
          email: row.email,
          designation: row.designation || current?.designation || 'Consultant',
          department: row.department || current?.department || 'Digital Transformation',
          country: row.country || current?.country || 'United Kingdom',
          reportingManagerId: row.reportingManagerId || current?.reportingManagerId,
          primaryCountryDirectorId: row.primaryCountryDirectorId || current?.primaryCountryDirectorId || 'cd-1',
          mappedCountryDirectorIds: (row.mappedCountryDirectorIds || current?.mappedCountryDirectorIds?.join('|') || row.primaryCountryDirectorId || 'cd-1').split('|').filter(Boolean),
          status: (row.status as Employee['status']) || current?.status || 'Active',
          utilizationEligible: row.utilizationEligible === undefined || row.utilizationEligible === ''
            ? current?.utilizationEligible
            : ['true', '1', 'yes', 'y'].includes(String(row.utilizationEligible).toLowerCase()),
          joiningDate: row.joiningDate || current?.joiningDate,
          exitDate: row.exitDate || current?.exitDate,
          standardWeeklyHours: row.standardWeeklyHours ? Number(row.standardWeeklyHours) : current?.standardWeeklyHours || 40,
          capacityType: row.capacityType || current?.capacityType || 'Delivery',
          contractType: row.contractType || current?.contractType || 'Permanent',
          entraObjectId: row.entraObjectId || current?.entraObjectId,
          teamsUserId: row.teamsUserId || current?.teamsUserId,
          plannedUtilization: current?.plannedUtilization || 0,
          actualUtilization: current?.actualUtilization || 0,
          activeProjectCount: current?.activeProjectCount || 0,
        };
        await employeeService.save(employee);
        saved += 1;
      }
    }

    if (pendingImport.id === 'clients') {
      const existing = await clientService.getAll();
      for (const row of pendingImport.validRows) {
        const current = existing.find(client => client.name.toLowerCase() === row.name.toLowerCase() || client.id === row.id);
        const client: Client = {
          id: current?.id || row.id || `client-${Date.now()}-${saved}`,
          name: row.name,
          industry: row.industry || current?.industry || 'Unclassified',
          accountOwnerId: row.accountOwnerId || current?.accountOwnerId,
          countryDirectorIds: (row.countryDirectorIds || current?.countryDirectorIds?.join('|') || '').split('|').filter(Boolean),
          status: (row.status as Client['status']) || current?.status || 'Active',
          createdAt: current?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await clientService.save(client);
        saved += 1;
      }
    }

    if (pendingImport.id === 'projects') {
      const [existing, allEmployees] = await Promise.all([projectService.getAll(), employeeService.getAll()]);
      for (const row of pendingImport.validRows) {
        const current = existing.find(p => p.projectCode === row.projectCode);
        const manager = allEmployees.find(employee => employee.id === row.managerId || employee.employeeId === row.managerId);
        const project: Project = {
          id: current?.id || `p-${Date.now()}-${saved}`,
          projectCode: row.projectCode,
          name: row.name,
          clientId: row.clientId || current?.clientId,
          client: row.client,
          managerId: manager?.id || row.managerId,
          managerName: manager?.name || current?.managerName || '',
          startDate: row.startDate || current?.startDate || new Date().toISOString().split('T')[0],
          endDate: row.endDate || current?.endDate || new Date().toISOString().split('T')[0],
          status: (row.status as Project['status']) || current?.status || 'Proposed',
          billable: row.billable ? row.billable === 'true' : current?.billable ?? true,
          plannedUtilization: current?.plannedUtilization || 0,
          actualUtilization: current?.actualUtilization || 0,
          resourceCount: current?.resourceCount || 0,
        };
        await projectService.save(project);
        saved += 1;
      }
    }

    if (pendingImport.id === 'allocations') {
      const [allEmployees, allProjects] = await Promise.all([employeeService.getAll(), projectService.getAll()]);
      for (const row of pendingImport.validRows) {
        const employee = allEmployees.find(item => item.id === row.employeeId || item.employeeId === row.employeeId);
        const project = allProjects.find(item => item.id === row.projectId || item.projectCode === row.projectId);
        if (!employee || !project) continue;
        const allocation: Allocation = {
          id: row.id || `a-${Date.now()}-${saved}`,
          employeeId: employee.id,
          projectId: project.id,
          projectName: project.name,
          projectManager: project.managerName,
          roleOnProject: row.roleOnProject || employee.designation,
          percentage: Number(row.percentage),
          startDate: row.startDate,
          endDate: row.endDate,
          billable: row.billable ? row.billable === 'true' : true,
          status: (row.status as Allocation['status']) || 'Active',
        };
        await allocationService.save(allocation);
        saved += 1;
      }
    }

    if (pendingImport.id === 'timesheets') {
      const [allEmployees, allProjects] = await Promise.all([employeeService.getAll(), projectService.getAll()]);
      const groups = new Map<string, TimesheetSummary>();
      for (const row of pendingImport.validRows) {
        const employee = allEmployees.find(item => item.id === row.employeeId || item.employeeId === row.employeeId);
        const project = allProjects.find(item => item.id === row.projectId || item.projectCode === row.projectId);
        if (!employee) continue;
        const status = (row.status as TimesheetSummary['status']) || 'Submitted';
        const key = `${employee.id}:${row.weekEnding}`;
        const current = groups.get(key) || {
          employeeId: employee.id,
          employeeName: employee.name,
          weekEnding: row.weekEnding,
          totalHours: 0,
          billableHours: 0,
          status,
          rejectionReason: row.rejectionReason,
          entries: [],
        };
        const billable = row.billable ? row.billable === 'true' : row.workType === 'Project Work';
        const hours = Number(row.hours);
        current.totalHours += hours;
        current.billableHours += billable ? hours : 0;
        current.entries.push({
          id: row.id || `ts-entry-${Date.now()}-${saved}`,
          employeeId: employee.id,
          projectId: project?.id,
          projectName: project?.name,
          workType: row.workType as WorkType,
          clientName: row.clientName,
          category: row.category,
          date: row.date,
          hours,
          remark: row.remark,
          status,
          billable: true,
          weekEnding: row.weekEnding,
        });
        groups.set(key, current);
        saved += 1;
      }
      for (const timesheet of groups.values()) {
        await timesheetService.save(timesheet);
      }
    }

    await adminService.saveImportExportLog({
      operation: 'Import',
      channel: pendingImport.title,
      fileName: pendingImport.fileName,
      status: pendingImport.errors.length > 0 ? 'Partial' : 'Success',
      totalRows: pendingImport.rows.length,
      validRows: saved,
      errorRows: pendingImport.errors.length,
      errors: pendingImport.errors,
    }, pendingImport.scope);
    setLastResult(`Applied ${saved} valid ${pendingImport.title.toLowerCase()} rows from ${pendingImport.fileName}.`);
    setPendingImport(null);
    refreshHistory();
  };

  const downloadErrorReport = () => {
    if (!pendingImport) return;
    downloadCsv(`${pendingImport.id}-import-errors.csv`, pendingImport.errors.map(error => ({
      fileName: pendingImport.fileName,
      channel: pendingImport.title,
      rowNumber: error.rowNumber,
      field: error.field || '',
      message: error.message,
      sourceIdentifier: error.sourceIdentifier || '',
    })), `${pendingImport.title} Error Report`);
  };

  const handleTemplate = (id: ImportChannel) => {
    const templates: Record<ImportChannel, Record<string, unknown>[]> = {
      employees: [orderImportRow('employees', {
        employeeId: 'BL-999',
        name: 'Example Consultant',
        email: 'example@example.test',
        designation: 'Consultant',
        department: 'Digital Transformation',
        country: 'United Kingdom',
        region: 'EMEA',
        businessUnit: 'Delivery',
        reportingManagerId: 'PM-9001',
        primaryCountryDirectorId: 'cd-1',
        mappedCountryDirectorIds: 'cd-1|cd-3',
        utilizationEligible: true,
        joiningDate: '2026-01-01',
        exitDate: '',
        standardWeeklyHours: 40,
        capacityType: 'Delivery',
        contractType: 'Permanent',
        entraObjectId: '',
        teamsUserId: '',
        roles: 'Employee',
        initialPassword: '',
        status: 'Active'
      })],
      clients: [orderImportRow('clients', {
        id: 'client-example',
        name: 'Example Client',
        industry: 'Banking',
        accountOwnerId: 'pm-1',
        countryDirectorIds: 'cd-1|cd-3',
        status: 'Active'
      })],
      projects: [orderImportRow('projects', {
        projectCode: 'P-2026-EXAMPLE',
        name: 'Example Client Delivery',
        clientId: 'client-example',
        client: 'Example Client',
        managerId: 'pm-1',
        startDate: '2026-05-01',
        endDate: '2026-08-31',
        status: 'Proposed',
        billable: true,
        projectType: 'Delivery',
        country: 'United Kingdom',
        notes: 'Example project import row',
      })],
      allocations: [orderImportRow('allocations', {
        id: 'allocation-example',
        employeeId: 'e-3',
        projectId: 'p-1',
        roleOnProject: 'RPA Developer',
        percentage: 50,
        startDate: '2026-05-01',
        endDate: '2026-08-31',
        billable: true,
        status: 'Active',
        comments: 'Example allocation import row',
      })],
      timesheets: [orderImportRow('timesheets', {
        employeeId: 'e-3',
        weekEnding: '2026-05-01',
        workType: 'Project Work',
        projectId: 'p-1',
        clientName: '',
        category: 'Delivery',
        date: '2026-04-27',
        hours: 8,
        remark: 'Client project delivery',
        billable: true,
        status: 'Submitted',
        rejectionReason: '',
      })]
    };
    downloadCsv(`${id}-template.csv`, templates[id] || [], `${id} Template`);
  };

  return (
    <div className="animate-in fade-in duration-500 pb-12">
      <PageHeader
        title="Import / Export"
        subtitle="Controlled bulk data operations and operational report generation center."
        breadcrumb={['System', 'Data Management']}
      />

      <div className="flex bg-slate-50 p-1 rounded-2xl w-fit mb-8 border border-slate-100">
         <button
           onClick={() => setActiveTab('import')}
           className={cn(
             "px-8 py-2.5 text-xs font-bold uppercase tracking-widest transition-all rounded-xl",
             activeTab === 'import' ? "bg-white text-heading shadow-sm" : "text-gray-400 hover:text-heading"
           )}
         >
           Bulk Imports
         </button>
         <button
           onClick={() => setActiveTab('export')}
           className={cn(
             "px-8 py-2.5 text-xs font-bold uppercase tracking-widest transition-all rounded-xl",
             activeTab === 'export' ? "bg-white text-heading shadow-sm" : "text-gray-400 hover:text-heading"
           )}
         >
           Data Exports
         </button>
      </div>

      {lastResult && (
        <div className="mb-8 bg-orange-50 border border-primary/20 rounded-2xl px-5 py-4 text-xs font-bold text-heading flex flex-wrap items-center justify-between gap-4">
          <span>{lastResult}</span>
          {pendingImport && (
            <div className="flex flex-wrap gap-3">
      {pendingImport.versionedOperation?.validationState === 'failed'
                && !pendingImport.versionedOperation.requiresNewImport && (
                  <button
                    onClick={retryVersionedImportDryRun}
                    disabled={isPreviewing || isApplying}
                    className="px-4 py-2 bg-white border border-primary/20 rounded-xl text-[10px] uppercase tracking-widest text-primary disabled:opacity-40"
                  >
                    {isPreviewing ? 'Retrying Validation…' : 'Retry Validation'}
                  </button>
                )}
              {pendingImport.errors.length > 0 && (
                <button
                  onClick={downloadErrorReport}
                  className="px-4 py-2 bg-white border border-primary/20 rounded-xl text-[10px] uppercase tracking-widest text-primary"
                >
                  Download Errors
                </button>
              )}
              <button
                onClick={applyPendingImport}
                disabled={isPreviewing || isApplying || pendingImport.validRows.length === 0
                  || Boolean(pendingImport.employeeImportOperation?.requiresNewImport)
                  || Boolean(pendingImport.versionedOperation && (
                    pendingImport.versionedOperation.validationState !== 'complete'
                    || pendingImport.versionedOperation.requiresNewImport
                  ))}
                className="btn-primary px-4 py-2 rounded-xl text-[10px] uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isApplying ? 'Applying…' : 'Apply Valid Rows'}
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'import' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
           <div className="space-y-6">
              <h3 className="text-sm font-bold text-heading uppercase tracking-widest px-1">Import Channels</h3>
              {importOptions.map(option => (
                <div key={option.id} className="bg-white border border-border-light rounded-2xl p-6 shadow-sm hover:border-primary/30 transition-all group">
                   <div className="flex items-start justify-between mb-6">
                      <div className="flex items-center gap-4">
                         <div className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center text-slate-dark group-hover:bg-primary group-hover:text-white transition-all shadow-inner">
                            <option.icon size={20} />
                         </div>
                         <div>
                            <h4 className="text-sm font-bold text-heading">{option.title}</h4>
                            <p className="text-xs text-body/60 mt-1">{option.description}</p>
                         </div>
                      </div>
                      <Badge variant="neutral" className="text-[9px] font-mono">
                        READY
                      </Badge>
                   </div>

                   <div className="grid grid-cols-2 gap-4">
                      <button
                        onClick={() => handleTemplate(option.id)}
                        className="flex items-center justify-center gap-2 py-3 bg-slate-50 hover:bg-slate-100 border border-slate-100 rounded-xl text-[10px] font-bold uppercase tracking-widest text-heading transition-colors"
                      >
                         <Download size={14} className="text-primary" /> Template
                      </button>
                      <label className="flex items-center justify-center gap-2 py-3 bg-white border-2 border-dashed border-slate-200 hover:border-primary/50 hover:bg-orange-50 rounded-xl text-[10px] font-bold uppercase tracking-widest text-primary transition-all cursor-pointer">
                         <Upload size={14} /> Dry Run CSV
                         <input
                          type="file"
                          accept=".csv,text/csv"
                          className="hidden"
                          disabled={isApplying}
                          onChange={(event) => handleImport(option.id, event.target.files?.[0])}
                         />
                      </label>
                   </div>
                </div>
              ))}
           </div>

           <div className="space-y-8">
              <div className="bg-slate-dark text-white rounded-3xl p-8 shadow-xl relative overflow-hidden">
                 <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-6">
                       <ShieldCheck className="text-primary" size={24} />
                       <h3 className="text-lg font-bold tracking-tight">Import Governance</h3>
                    </div>
                    <ul className="space-y-4">
                       {[
                         { label: 'CSV Dry Run First', desc: 'Uploads validate headers, required fields, references, dates, and statuses before writing data.' },
                         { label: 'Apply Valid Rows', desc: 'Users explicitly apply validated rows; invalid rows stay out and can be downloaded as an error report.' },
                         { label: 'Traceable Operations', desc: 'Every dry run, final import, error report, template, and export is logged with user and timestamp.' },
                       ].map((rule, idx) => (
                         <li key={idx} className="flex gap-4">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                            <div>
                               <p className="text-xs font-bold text-white/90">{rule.label}</p>
                               <p className="text-[10px] text-white/40 mt-0.5">{rule.desc}</p>
                            </div>
                         </li>
                       ))}
                    </ul>
                 </div>
                 <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 blur-[100px] -mr-32 -mt-32 rounded-full" />
              </div>

              <ImportHistoryPanel loadHistory={adminService.getImportExportLogs} revision={historyRevision} />
           </div>
        </div>
      ) : (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {exportOptions.map(option => (
                <div key={option.id} className="bg-white border border-border-light rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-primary/20 transition-all flex flex-col group">
                   <div className="flex items-center justify-between mb-6">
                      <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-all shadow-inner">
                         <Search size={18} />
                      </div>
                      <div className="flex gap-1.5">
                         {option.formats.map(f => (
                           <span key={f} className="text-[9px] font-bold px-1.5 py-0.5 bg-slate-100 rounded text-gray-500">{f}</span>
                         ))}
                      </div>
                   </div>

                   <h4 className="text-sm font-bold text-heading mb-2">{option.title}</h4>
                   <div className="flex flex-wrap gap-2 mb-8">
                      {option.filters.map(filter => (
                        <div key={filter} className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 uppercase bg-slate-50 px-2.5 py-1 rounded-lg border border-slate-100">
                           <Filter size={10} /> {filter}
                        </div>
                      ))}
                   </div>

                   <div className="mt-auto pt-6 border-t border-slate-50 flex items-center gap-3">
                      <select className="flex-1 bg-slate-50 border border-slate-100 rounded-xl px-4 py-2.5 text-xs font-bold text-heading outline-none focus:border-primary transition-all shadow-sm">
                         <option>Standard CSV</option>
                         <option>Audit CSV</option>
                         <option>Raw CSV</option>
                      </select>
                      <button
                        onClick={() => handleExport(option.id)}
                        title={`Download ${option.title}`}
                        className="btn-primary p-3 rounded-xl shadow-lg shadow-primary/20"
                      >
                         <Download size={18} />
                      </button>
                   </div>
                </div>
              ))}
           </div>

           <div className="bg-orange-50 border border-primary/20 rounded-3xl p-8 flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-6">
                 <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-primary shadow-md">
                    <ShieldCheck size={32} />
                 </div>
                 <div>
                    <h4 className="text-lg font-bold text-heading tracking-tight">Access Controlled Reporting</h4>
                    <p className="text-sm text-body/70 mt-1 leading-relaxed max-w-lg">
                       Exports are audited and restricted by system role. Current implementation supports CSV output;
                       XLSX/PDF generation remains a backend roadmap item.
                    </p>
                 </div>
              </div>
              <button
                onClick={() => { window.location.href = '/admin'; }}
                className="btn-secondary py-3 px-8 text-xs font-bold uppercase tracking-widest shadow-sm"
              >
                 Permissions Admin
              </button>
           </div>
        </div>
      )}
    </div>
  );
};
