import {evidenceUrlInput,resolveWorkEvidenceReplacement,readWorkEvidenceAudit} from '../work-capture/work-evidence.mjs';
import {validateCapturePolicy,captureHoursInput,assertCaptureReplacementPeriods} from '../work-capture/capture-policy.mjs';
import {canonicalHours,sumHours} from '../work-capture/work-hours.mjs';
import {lockWorkPolicy,validateAssignmentPolicy,validateWorkEntries,assertWorkActorScope,assertTimesheetEditable,validateImportWorkStatus,retainWorkSubmission,WorkPolicyError} from '../work-capture/assignment-work-policy.mjs';
import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {
  createScopedIdempotencyLockKey,
  hashImportRequest,
  normalizeIdempotencyKey,
} from './idempotency.mjs';

export const ALLOCATION_IMPORT_SCHEMA_VERSION = 'allocation-control/1';
export const TIMESHEET_IMPORT_SCHEMA_VERSION = 'timesheet-import/1';

const legacyImportLog = row => {
  const {schema_version: _schemaVersion, dry_run: _dryRun, ...legacyRow} = row;
  return legacyRow;
};

const responseFromBatch = (row, versioned) => ({
  status: row.status,
  totalRows: row.total_rows,
  validRows: row.valid_rows,
  errorRows: row.error_rows,
  errors: Array.isArray(row.errors) ? row.errors : [],
  log: versioned ? row : legacyImportLog(row),
});

const optionalImportEnum = values => z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.enum(values).optional(),
);

const optionalBlankId = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const versionedContext = (req, res, {schemaVersion, label}) => {
  if (req.apiVersion !== 'v1') return null;
  const rawKey = req.get?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    res.status(400).json({error: {code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'The Idempotency-Key header is required.'}});
    return false;
  }
  const idempotencyKey = normalizeIdempotencyKey(rawKey);
  if (!idempotencyKey) {
    res.status(400).json({error: {code: 'INVALID_IDEMPOTENCY_KEY', message: 'The Idempotency-Key header is invalid.'}});
    return false;
  }
  if (!req.body?.schemaVersion) {
    res.status(400).json({error: {code: 'SCHEMA_VERSION_REQUIRED', message: `The ${label} import schema version is required.`}});
    return false;
  }
  if (req.body.schemaVersion !== schemaVersion) {
    res.status(400).json({error: {code: 'UNSUPPORTED_SCHEMA_VERSION', message: `The ${label} import schema version is not supported.`}});
    return false;
  }
  const actorId = typeof req.user?.sub === 'string' || typeof req.user?.sub === 'number'
    ? String(req.user.sub)
    : '';
  if (!actorId) {
    res.status(401).json({error: {code: 'AUTHENTICATION_REQUIRED', message: 'An authenticated account is required.'}});
    return false;
  }
  return {idempotencyKey, actorId};
};

const beginImportOperation = async ({client, req, res, channel, versioned, context, requestHash}) => {
  if (!versioned) return {transactionOpen: true, replayed: false};

  const scope = req.organizationScope;
  const lockKey = createScopedIdempotencyLockKey({
    organizationId: scope.organizationId,
    legalEntityId: scope.legalEntityId,
    actorId: context.actorId,
    channel,
    idempotencyKey: context.idempotencyKey,
  });
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
  const existing = await client.query(
    'select request_hash, batch_id from import_export_idempotency where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and channel=$4 and idempotency_key=$5',
    [scope.organizationId, scope.legalEntityId, context.actorId, channel, context.idempotencyKey],
  );
  if (existing.rowCount === 0) return {transactionOpen: true, replayed: false};

  if (existing.rows[0].request_hash !== requestHash) {
    await client.query('rollback');
    res.status(409).json({error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request.'}});
    return {transactionOpen: false, handled: true};
  }

  const previousBatch = await client.query(
    'select * from import_export_logs where id=$1 and organization_id=$2 and legal_entity_id=$3 and channel=$4 limit 1',
    [existing.rows[0].batch_id, scope.organizationId, scope.legalEntityId, channel],
  );
  if (previousBatch.rowCount !== 1) throw new Error('Idempotency record has no matching scoped import batch.');
  await client.query('commit');
  res.json(responseFromBatch(previousBatch.rows[0], true));
  return {transactionOpen: false, handled: true, replayed: true};
};

const canonicalRequest = (data, rows) => ({
  ...data,
  totalRows: data.totalRows ?? rows.length,
  clientErrors: data.clientErrors || [],
});

const persistIdempotency = async ({client, scope, context, channel, requestHash}) => {
  await client.query(
    'insert into import_export_idempotency (organization_id, legal_entity_id, actor_id, channel, idempotency_key, request_hash, batch_id) values ($1,$2,$3,$4,$5,$6,$7)',
    [scope.organizationId, scope.legalEntityId, context.actorId, channel, context.idempotencyKey, requestHash, context.batchId],
  );
};

const makeBaseSchema = (rowSchema, importErrorRowSchema, schemaVersion) => z.object({
  fileName: z.string().min(1),
  rows: z.array(rowSchema),
  totalRows: z.number().int().min(0).optional(),
  clientErrors: z.array(importErrorRowSchema).optional(),
  schemaVersion: z.literal(schemaVersion),
  dryRun: z.boolean().default(false),
});

const withRowsRequiredForApply = schema => schema.superRefine((data, context) => {
  if (!data.dryRun && data.rows.length === 0) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ['rows'], message: 'At least one valid row is required to apply an import.'});
  }
});

const legacySchema = (rowSchema, importErrorRowSchema) => z.object({
  fileName: z.string().min(1),
  rows: z.array(rowSchema).min(1),
  totalRows: z.number().int().min(0).optional(),
  clientErrors: z.array(importErrorRowSchema).optional(),
});

const getSchema = ({versioned, rowSchema, importErrorRowSchema, schemaVersion}) => versioned
  ? withRowsRequiredForApply(makeBaseSchema(rowSchema, importErrorRowSchema, schemaVersion))
  : legacySchema(rowSchema, importErrorRowSchema);

const recordDryRunAudit = async (audit, client, req, {
  importBatchId,
  schemaVersion,
  status,
  totalRows,
  validRows,
  errorRows,
  fileName,
  channel,
  source,
}) => audit(client, req, {
  module: 'Import',
  action: `Dry Run ${channel.endsWith(' Import') ? channel : `${channel} Import`}`,
  entityType: 'ImportBatch',
  entityId: importBatchId,
  oldValue: null,
  newValue: {schemaVersion, status, totalRows, validRows, errorRows},
  details: `Validated ${channel.toLowerCase()} import ${fileName} without applying ${channel.toLowerCase()} rows`,
  source,
  importBatchId,
  importProcessingResult: 'Dry Run',
});

export const createOperationalImportRouter = ({
  pool,
  requireDatabase,
  requireAuth,
  requirePermission,
  audit,
  importErrorRowSchema,
  strictIsoDateSchema,
  parseBoolean,
  collectDuplicateImportRows,
  resolveImportApplyRowNumbers,
  attachImportErrorSourceIdentifiers,
  isAfterToday,
  isWorkDateInsideWeek,
  toIsoDate,
  round1,
  getSetting,
  assertReportingPeriodAllows,
  REPORTING_PERIOD_OPERATIONS,
  ReportingPeriodError,
  sendReportingPeriodError,
  upsertWorkApproval,
  logError = error => console.error(error),
}) => {
  const requiredFunctions = [requireDatabase, requireAuth, requirePermission, audit, parseBoolean,
    collectDuplicateImportRows, resolveImportApplyRowNumbers, attachImportErrorSourceIdentifiers,
    isAfterToday, isWorkDateInsideWeek, toIsoDate, round1, getSetting, assertReportingPeriodAllows, sendReportingPeriodError, logError];
  if (!pool || typeof pool.connect !== 'function'
      || !requiredFunctions.every(value => typeof value === 'function')
      || typeof importErrorRowSchema?.safeParse !== 'function'
      || typeof strictIsoDateSchema?.safeParse !== 'function'
      || !REPORTING_PERIOD_OPERATIONS || !ReportingPeriodError) {
    throw new TypeError('Operational import routes require database, authorization, validation, and reporting-period helpers.');
  }

  const allocationRowSchema = versioned => z.object({
    id: versioned ? optionalBlankId : z.string().min(1).optional(),
    employeeId: z.string().min(1),
    projectId: z.string().min(1),
    roleOnProject: z.string().optional(),
    percentage: z.coerce.number().min(0).max(200),
    startDate: strictIsoDateSchema,
    endDate: strictIsoDateSchema,
    billable: z.union([z.boolean(), z.string()]).optional(),
    status: versioned ? optionalImportEnum(['Active', 'Paused', 'Completed']) : z.enum(['Active', 'Paused', 'Completed']).optional(),
    comments: z.string().optional(),
  });
  const timesheetRowSchema = versioned => z.object({
    employeeId: z.string().min(1),
    weekEnding: strictIsoDateSchema,
    workType: z.enum(['Project Work', 'Client Misc Task']),
    projectId: z.string().optional(),
    clientName: z.string().optional(),
    category: z.string().optional(),
    date: strictIsoDateSchema,
    hours: captureHoursInput,
    remark: z.string().optional(),
    evidenceUrl: evidenceUrlInput,
    billable: z.union([z.boolean(), z.string()]).optional(),
    status: versioned ? optionalImportEnum(['Draft', 'Submitted', 'Approved', 'Rejected']) : z.enum(['Draft', 'Submitted', 'Approved', 'Rejected']).optional(),
    rejectionReason: z.string().optional(),
  });

  const router = Router();

  router.post('/imports/allocations/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
    const channel = 'Allocation Control';
    const versioned = req.apiVersion === 'v1';
    const context = versionedContext(req, res, {schemaVersion: ALLOCATION_IMPORT_SCHEMA_VERSION, label: 'Allocation Control'});
    if (versioned && !context) return;
    const parsed = getSchema({versioned, rowSchema: allocationRowSchema(versioned), importErrorRowSchema, schemaVersion: ALLOCATION_IMPORT_SCHEMA_VERSION}).safeParse(req.body);
    if (!parsed.success) {
      if (versioned) res.status(400).json({error: {code: 'INVALID_IMPORT_REQUEST', message: 'The Allocation Control import request is invalid.'}});
      else res.status(400).json({error: parsed.error.flatten()});
      return;
    }

    const client = await pool.connect();
    const clientErrors = parsed.data.clientErrors || [];
    const {rowNumbers, mappingIsReliable} = resolveImportApplyRowNumbers({rows: parsed.data.rows, totalRows: parsed.data.totalRows, clientErrors});
    const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows,
      row => [{field: 'id', value: row.id, label: 'allocation ID'}], index => rowNumbers[index]);
    const errors = [...clientErrors, ...duplicateImportRows.errors];
    const importBatchId = randomUUID();
    const dryRun = versioned && parsed.data.dryRun;
    const scope = req.organizationScope;
    const requestHash = versioned ? hashImportRequest(canonicalRequest(parsed.data, parsed.data.rows)) : null;
    const idempotency = context ? {...context, batchId: importBatchId} : null;
    const stagedAllocationChanges = [];
    const seenAllocationNaturalKeys = new Set();
    let saved = 0;
    let transactionOpen = false;
    try {
      await client.query('begin');
      transactionOpen = true;
      const transaction = await beginImportOperation({client, req, res, channel, versioned, context, requestHash});
      transactionOpen = transaction.transactionOpen;
      if (transaction.handled) return;
      await lockWorkPolicy(client,req);
      const blockOverAllocation = await getSetting('blockOverAllocation', false);

      for (const [index, row] of parsed.data.rows.entries()) {
        const rowNumber = rowNumbers[index];
        if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
        const rowErrors = [];
        if (row.endDate < row.startDate) rowErrors.push({rowNumber, field: 'endDate', message: 'End date must be on or after start date.'});

        const employee = (await client.query(`
          select * from employees
          where (id = $1 or employee_id = $1)
            and organization_id=$2 and legal_entity_id=$3
          limit 1
        `, [row.employeeId,scope.organizationId,scope.legalEntityId])).rows[0];
        if (!employee) rowErrors.push({rowNumber, field: 'employeeId', message: 'Allocation must reference an active employee.'});

        const project = (await client.query(`
          select * from projects
          where (id = $1 or project_code = $1)
            and organization_id=$2 and legal_entity_id=$3
          limit 1
        `, [row.projectId,scope.organizationId,scope.legalEntityId])).rows[0];
        if (!project) {
          rowErrors.push({rowNumber, field: 'projectId', message: 'Allocation must reference an active or proposed project.'});
        }

        const previous = row.id
          ? (await client.query(`select pa.* from project_allocations pa
            join projects p on p.id=pa.project_id and p.organization_id=pa.organization_id
            join employees e on e.id=pa.employee_id and e.organization_id=pa.organization_id
            where pa.id=$1 and pa.organization_id=$2 and pa.legal_entity_id=$3 and p.legal_entity_id=$3 and e.legal_entity_id=$3 limit 1`,
          [row.id,scope.organizationId,scope.legalEntityId])).rows[0]
          : null;
        if (row.id && !previous && (await client.query('select 1 from project_allocations where id=$1',[row.id])).rowCount) {
          errors.push({rowNumber,field:'id',message:'Allocation is not available in the authorized organization and legal entity.'});
          continue;
        }

        if (versioned && employee && project) {
          const naturalKey = [employee.id, project.id, row.startDate, row.endDate].join('|');
          if (seenAllocationNaturalKeys.has(naturalKey)) {
            rowErrors.push({rowNumber, field: 'allocationKey', message: 'This employee, project, and date range already appears in the import.'});
          } else {
            seenAllocationNaturalKeys.add(naturalKey);
          }
        }

        const nextStatus = row.status || previous?.status || 'Active';
        if(employee&&project&&row.endDate>=row.startDate){
          try{
            if(previous)await assertWorkActorScope(client,req,previous.employee_id,previous.project_id,{assignment:true});
            await validateAssignmentPolicy(client,req,{employee_id:employee.id,project_id:project.id,start_date:row.startDate,end_date:row.endDate,billable:parseBoolean(row.billable,previous?.billable??true)});
          }catch(error){if(!(error instanceof WorkPolicyError))throw error;rowErrors.push({rowNumber,field:'projectId',message:error.message,code:error.code});}
        }

        if (blockOverAllocation && employee && nextStatus === 'Active') {
          await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [employee.id]);
          const loadResult = await client.query(`
            select coalesce(sum(percentage), 0) as total
            from project_allocations
            where employee_id = $1
              and organization_id = $5 and legal_entity_id = $6
              and id <> coalesce($2, '')
              and status = 'Active'
              and daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
          `, [employee.id, row.id || null, row.startDate, row.endDate, scope.organizationId, scope.legalEntityId]);
          let total = Number(loadResult.rows[0]?.total || 0);
          if (dryRun) {
            for (const staged of stagedAllocationChanges) {
              if (staged.previous?.status === 'Active'
                  && staged.previous.employee_id === employee.id
                  && toIsoDate(staged.previous.start_date) <= row.endDate
                  && toIsoDate(staged.previous.end_date) >= row.startDate) {
                total -= parseFloat(staged.previous.percentage || 0);
              }
              if (staged.employeeId === employee.id && staged.next.status === 'Active'
                  && staged.next.startDate <= row.endDate && staged.next.endDate >= row.startDate) {
                total += staged.next.percentage;
              }
            }
          }
          total += Number(row.percentage);
          if (total > 100) rowErrors.push({rowNumber, field: 'percentage', message: `Allocation would exceed 100% for overlapping dates (${total}%).`});
        }

        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          continue;
        }

        const nextValues = {
          status: nextStatus,
          startDate: row.startDate,
          endDate: row.endDate,
          percentage: Number(row.percentage),
        };
        if (dryRun) {
          stagedAllocationChanges.push({employeeId: employee.id, previous, next: nextValues});
          saved += 1;
          continue;
        }

        const result = await client.query(`
          insert into project_allocations (id, employee_id, project_id, role_on_project, percentage, start_date, end_date, billable, status, comments, organization_id, legal_entity_id)
          values (coalesce($1, 'a-' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          on conflict (id) do update set
            employee_id = excluded.employee_id,
            project_id = excluded.project_id,
            role_on_project = excluded.role_on_project,
            percentage = excluded.percentage,
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            billable = excluded.billable,
            status = excluded.status,
            comments = excluded.comments,
            updated_at = now()
          where project_allocations.organization_id=excluded.organization_id and project_allocations.legal_entity_id=excluded.legal_entity_id
          returning *
        `, [
          previous?.id || row.id || null,
          employee.id,
          project.id,
          row.roleOnProject || previous?.role_on_project || employee.designation,
          row.percentage,
          row.startDate,
          row.endDate,
          parseBoolean(row.billable, previous?.billable ?? true),
          row.status || previous?.status || 'Active',
          row.comments || previous?.comments || null,
          scope.organizationId,
          scope.legalEntityId,
        ]);
        const allocation = result.rows[0];
        await audit(client, req, {
          module: 'Import',
          action: previous ? 'Import Update Allocation' : 'Import Create Allocation',
          entityType: 'Allocation',
          entityId: allocation.id,
          oldValue: previous,
          newValue: allocation,
          details: `${previous ? 'Updated' : 'Created'} allocation for ${employee.employee_id} on ${project.project_code} from ${parsed.data.fileName}`,
          source: 'Allocation Control CSV',
          importBatchId,
          sourceIdentifier: row.id ?? null,
          importProcessingResult: 'Success',
        });
        saved += 1;
      }

      const responseErrors = attachImportErrorSourceIdentifiers({
        errors, clientErrors, rows: parsed.data.rows, rowNumbers, mappingIsReliable,
        sourceIdentifierForRow: row => row.id ?? null,
      });
      const status = dryRun ? 'Dry Run' : saved === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
      const totalRows = parsed.data.totalRows ?? parsed.data.rows.length;
      if (dryRun) await recordDryRunAudit(audit, client, req, {
        importBatchId, schemaVersion: parsed.data.schemaVersion, status, totalRows,
        validRows: saved, errorRows: errors.length, fileName: parsed.data.fileName,
        channel, source: 'Allocation Control CSV',
      });
      const logResult = await client.query(`
        insert into import_export_logs (id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run)
        values ($1,'Import','Allocation Control',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        returning *
      `, [importBatchId, parsed.data.fileName, status, totalRows, saved, errors.length,
        errors.length ? JSON.stringify(responseErrors) : null, req.user.username, scope.organizationId,
        scope.legalEntityId, versioned ? parsed.data.schemaVersion : null, dryRun]);
      if (versioned) await persistIdempotency({client, scope, context: idempotency, channel, requestHash});
      await client.query('commit');
      transactionOpen = false;
      res.json(responseFromBatch(logResult.rows[0], versioned));
    } catch (error) {
      if (transactionOpen) {
        try { await client.query('rollback'); } catch { /* Preserve the original failure. */ }
      }
      logError(error);
      if (versioned) res.status(500).json({error: {code: 'ALLOCATION_IMPORT_FAILED', message: 'The Allocation Control import could not be completed.'}});
      else res.status(500).json({error: 'Allocation import apply failed'});
    } finally {
      client.release();
    }
  });

  router.post('/imports/timesheets/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
    const channel = 'Timesheet Import';
    const versioned = req.apiVersion === 'v1';
    const context = versionedContext(req, res, {schemaVersion: TIMESHEET_IMPORT_SCHEMA_VERSION, label: 'timesheet'});
    if (versioned && !context) return;
    const parsed = getSchema({versioned, rowSchema: timesheetRowSchema(versioned), importErrorRowSchema, schemaVersion: TIMESHEET_IMPORT_SCHEMA_VERSION}).safeParse(req.body);
    if (!parsed.success) {
      if (versioned) res.status(400).json({error: {code: 'INVALID_IMPORT_REQUEST', message: 'The timesheet import request is invalid.'}});
      else res.status(400).json({error: parsed.error.flatten()});
      return;
    }

    const clientErrors = parsed.data.clientErrors || [];
    const {rowNumbers, mappingIsReliable} = resolveImportApplyRowNumbers({rows: parsed.data.rows, totalRows: parsed.data.totalRows, clientErrors});
    const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => versioned ? [] : [{
      field: 'timesheetEntryKey',
      label: 'Timesheet entry key',
      value: [row.employeeId, row.weekEnding, row.date, row.workType, row.projectId || row.clientName].join('|'),
    }], index => rowNumbers[index]);
    const client = await pool.connect();
    const errors = [...clientErrors, ...duplicateImportRows.errors];
    const importBatchId = randomUUID();
    const dryRun = versioned && parsed.data.dryRun;
    const scope = req.organizationScope;
    const requestHash = versioned ? hashImportRequest(canonicalRequest(parsed.data, parsed.data.rows)) : null;
    const idempotency = context ? {...context, batchId: importBatchId} : null;
    const groups = new Map();
    const seenTimesheetEntryKeys = new Set();
    const stagedCaptureReplacements = [];
    let validEntryRows = 0;
    let transactionOpen = false;
    try {
      await client.query('begin');
      transactionOpen = true;
      const transaction = await beginImportOperation({client, req, res, channel, versioned, context, requestHash});
      transactionOpen = transaction.transactionOpen;
      if (transaction.handled) return;
      await lockWorkPolicy(client,req);

      for (const [index, row] of parsed.data.rows.entries()) {
        const rowNumber = rowNumbers[index];
        if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
        const rowErrors = [];
        if (((row.status || 'Submitted') === 'Submitted' && isAfterToday(row.weekEnding)) || isAfterToday(row.date)) rowErrors.push({rowNumber, field: 'date', message: 'Future work dates cannot be imported; Submitted headers must also end no later than today.'});
        if (!isWorkDateInsideWeek(row.date, row.weekEnding)) {
          rowErrors.push({rowNumber, field: 'date', message: `Entry work date ${row.date} must fall within the seven-day period ending ${row.weekEnding}.`});
        }

        const employee = (await client.query(`
          select id, employee_id, name, status
          from employees
          where (id = $1 or employee_id = $1)
            and organization_id = $2 and legal_entity_id = $3

          limit 1
        `, [row.employeeId, scope.organizationId, scope.legalEntityId])).rows[0];
        if (!employee) rowErrors.push({rowNumber, field: 'employeeId', message: 'Timesheet must reference an active employee.'});

        let project = null;
        if (row.workType === 'Project Work') {
          if (!row.projectId) rowErrors.push({rowNumber, field: 'projectId', message: 'Project Work entries require a project.'});
          else {
            project = (await client.query(`
              select id, name, status
              from projects
              where (id = $1 or project_code = $1)
                and organization_id = $2 and legal_entity_id = $3

              limit 1
            `, [row.projectId, scope.organizationId, scope.legalEntityId])).rows[0];
            if (!project) rowErrors.push({rowNumber, field: 'projectId', message: 'Project Work entries must reference active, proposed, or on-hold projects.'});

          }
        }
        if (row.workType === 'Client Misc Task' && !row.clientName) rowErrors.push({rowNumber, field: 'clientName', message: 'Client Misc Task entries require a client name.'});
        const naturalTarget = row.workType === 'Project Work' ? project?.id : row.clientName;
        if (versioned && employee && naturalTarget) {
          const naturalKey = [employee.id, row.weekEnding, row.date, row.workType, naturalTarget].join('|');
          if (seenTimesheetEntryKeys.has(naturalKey)) {
            rowErrors.push({rowNumber, field: 'timesheetEntryKey', message: 'This employee, week, date, and work item already appears in the import.'});
          } else {
            seenTimesheetEntryKeys.add(naturalKey);
          }
        }
        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          continue;
        }

        const status = row.status || 'Submitted';
        try{validateImportWorkStatus(status);}catch(error){errors.push({rowNumber,field:'status',message:error.message,code:error.code});continue;}
        const key = `${employee.id}:${row.weekEnding}`;
        const group = groups.get(key) || {
          employee,
          weekEnding: row.weekEnding,
          status,
          rejectionReason: row.rejectionReason || null,
          entries: [],
        };
        if (group.status !== status) {
          errors.push({rowNumber, field: 'status', message: 'Rows for the same employee/week must use the same timesheet status.'});
          continue;
        }
        group.entries.push({
          rowNumber,
          projectId: project?.id || null,
          workType: row.workType,
          clientName: row.clientName || null,
          category: row.category || null,
          workDate: row.date,
          hours: canonicalHours(row.hours),
          remark: row.remark || null,
          evidenceUrl: row.evidenceUrl,
          billable: parseBoolean(row.billable, row.workType === 'Project Work'),
        });
        groups.set(key, group);
        validEntryRows += 1;
      }

      for (const group of groups.values()) {
        let policyEntries;
        let previous,previousEvidence;
        try {
          if(group.entries.length>100)throw new WorkPolicyError('WORK_ENTRY_LIMIT','A work period may contain at most 100 entries.');
          await lockWorkPolicy(client,req,[group.employee.id]);
          previous=(await client.query('select * from timesheets where organization_id = $1 and legal_entity_id = $2 and employee_id = $3 and week_ending = $4 for update',[scope.organizationId,scope.legalEntityId,group.employee.id,group.weekEnding])).rows[0];
          assertTimesheetEditable(previous);
          previousEvidence=await readWorkEvidenceAudit(client,previous?.id);
          await assertCaptureReplacementPeriods(client,req,previous?.id);
          policyEntries=await validateWorkEntries(client,req,group.employee.id,group.entries.map(entry=>({project_id:entry.projectId,work_type:entry.workType,client_name:entry.clientName,category:entry.category,remark:entry.remark,evidence_url:entry.evidenceUrl,work_date:entry.workDate,hours:entry.hours,billable:entry.billable})));
          policyEntries=await resolveWorkEvidenceReplacement(client,previous?.id,policyEntries);
          policyEntries=await validateCapturePolicy(client,req,group.employee.id,policyEntries,{replacementTimesheetId:previous?.id,stagedReplacements:dryRun?stagedCaptureReplacements:[]});
          group.entries=group.entries.map((entry,index)=>({...entry,hours:policyEntries[index].hours,billable:policyEntries[index].billable,evidenceUrl:policyEntries[index].evidence_url}));
          await assertReportingPeriodAllows(client, {
            organizationId: scope.organizationId,
            legalEntityId: scope.legalEntityId,
            relevantDates: [group.weekEnding, ...group.entries.map(entry => entry.workDate)],
            operation: REPORTING_PERIOD_OPERATIONS.CONTENT,
          });
        } catch (error) {
          if (!(error instanceof ReportingPeriodError)&&!(error instanceof WorkPolicyError)) throw error;
          errors.push(...group.entries.map(entry => ({rowNumber: entry.rowNumber, field: 'date', message: error.message, code: error.code})));
          validEntryRows -= group.entries.length;
          continue;
        }
        if (dryRun) {
          stagedCaptureReplacements.push({employeeId:group.employee.id,timesheetId:previous?.id||null,entries:policyEntries});
          continue;
        }

        const totalHours=sumHours(group.entries.map(entry=>entry.hours));
        const billableHours=sumHours(group.entries.filter(entry=>entry.billable).map(entry=>entry.hours));
        const timesheetResult = await client.query(`
          insert into timesheets (employee_id, week_ending, status, total_hours, billable_hours, rejection_reason, submitted_at, organization_id, legal_entity_id)
          values ($1,$2,case when $3::text in ('Draft','Submitted') then 'Draft' end,$4,$5,$6,null,$7,$8)
          on conflict (organization_id, employee_id, week_ending) do update set
            status = excluded.status,
            total_hours = excluded.total_hours,
            billable_hours = excluded.billable_hours,
            rejection_reason = excluded.rejection_reason,
            submitted_at = case when excluded.status = 'Submitted' then coalesce(timesheets.submitted_at, now()) else timesheets.submitted_at end,
            updated_at = now()
          returning *
        `, [group.employee.id, group.weekEnding, group.status, totalHours, billableHours, group.rejectionReason, scope.organizationId, scope.legalEntityId]);
        let timesheet = timesheetResult.rows[0];
        await client.query('delete from timesheet_entries where timesheet_id = $1', [timesheet.id]);
        const savedEntries=[];
        for (const [index,entry] of group.entries.entries()) {
          const inserted=await client.query(`
            insert into timesheet_entries (timesheet_id, project_id, work_type, client_name, category, work_date, hours, remark, billable, evidence_url)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *,work_date::text
          `, [timesheet.id, entry.projectId, entry.workType, entry.clientName, entry.category, entry.workDate, entry.hours, entry.remark, entry.billable, entry.evidenceUrl]);
          savedEntries.push({...inserted.rows[0],policy:policyEntries[index].policy,capturePolicyReference:policyEntries[index].capturePolicyReference});
        }
        if(group.status==='Submitted'){
          timesheet=(await client.query("update timesheets set status='Submitted',submitted_at=now(),updated_at=now() where id=$1 returning *",[timesheet.id])).rows[0];
          await retainWorkSubmission(client,req,{...timesheet,week_ending:group.weekEnding},savedEntries,'Timesheet Import CSV');
          if(typeof upsertWorkApproval!=='function')throw new Error('Work import submission requires an approval writer.');
          await upsertWorkApproval(client,req,{entityType:'Timesheet',entityId:String(timesheet.id),subjectEmployeeId:group.employee.id,requesterId:group.employee.id,requesterName:group.employee.name,status:'Pending',source:'Timesheet Import CSV'});
        }
        await audit(client, req, {
          module: 'Import',
          action: previous ? 'Import Update Timesheet' : 'Import Create Timesheet',
          entityType: 'Timesheet',
          entityId: String(timesheet.id),
          oldValue: previous?{...previous,entryEvidence:previousEvidence}:null,
          newValue: {...timesheet,entryEvidence:savedEntries.map(entry=>({id:entry.id,evidence_url:entry.evidence_url}))},
          details: `${previous ? 'Updated' : 'Created'} ${group.status} timesheet for ${group.employee.employee_id}, week ending ${group.weekEnding} from ${parsed.data.fileName}`,
          reason: group.rejectionReason,
          source: 'Timesheet Import CSV',
          importBatchId,
          sourceIdentifier: null,
          importProcessingResult: 'Success',
        });
      }

      const responseErrors = attachImportErrorSourceIdentifiers({
        errors, clientErrors, rows: parsed.data.rows, rowNumbers, mappingIsReliable,
        sourceIdentifierForRow: () => null,
        allowClientSourceIdentifiers: false,
      });
      const status = dryRun ? 'Dry Run' : validEntryRows === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
      const totalRows = parsed.data.totalRows ?? parsed.data.rows.length;
      if (dryRun) await recordDryRunAudit(audit, client, req, {
        importBatchId, schemaVersion: parsed.data.schemaVersion, status, totalRows,
        validRows: validEntryRows, errorRows: errors.length, fileName: parsed.data.fileName,
        channel, source: 'Timesheet Import CSV',
      });
      const logResult = await client.query(`
        insert into import_export_logs (id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run)
        values ($1,'Import','Timesheet Import',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        returning *
      `, [importBatchId, parsed.data.fileName, status, totalRows, validEntryRows, errors.length,
        errors.length ? JSON.stringify(responseErrors) : null, req.user.username, scope.organizationId,
        scope.legalEntityId, versioned ? parsed.data.schemaVersion : null, dryRun]);
      if (versioned) await persistIdempotency({client, scope, context: idempotency, channel, requestHash});
      await client.query('commit');
      transactionOpen = false;
      res.json(responseFromBatch(logResult.rows[0], versioned));
    } catch (error) {
      if (transactionOpen) {
        try { await client.query('rollback'); } catch { /* Preserve the original failure. */ }
      }
      if (sendReportingPeriodError(res, error)) return;
      logError(error);
      if (versioned) res.status(500).json({error: {code: 'TIMESHEET_IMPORT_FAILED', message: 'The timesheet import could not be completed.'}});
      else res.status(500).json({error: 'Timesheet import apply failed'});
    } finally {
      client.release();
    }
  });

  return router;
};
