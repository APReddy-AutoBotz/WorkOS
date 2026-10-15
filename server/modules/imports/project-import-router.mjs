import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {
  createProjectCodeLockKey,
  createScopedIdempotencyLockKey,
  hashImportRequest,
  normalizeIdempotencyKey,
} from './idempotency.mjs';

export const PROJECT_IMPORT_SCHEMA_VERSION = 'project-master/1';

const legacyProjectImportLog = row => {
  const {schema_version: _schemaVersion, dry_run: _dryRun, ...legacyRow} = row;
  return legacyRow;
};

const responseFromBatch = (row, versioned) => ({
  status: row.status,
  totalRows: row.total_rows,
  validRows: row.valid_rows,
  errorRows: row.error_rows,
  errors: Array.isArray(row.errors) ? row.errors : [],
  log: versioned ? row : legacyProjectImportLog(row),
});

const optionalImportEnum = values => z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.enum(values).optional(),
);

export const createProjectImportRouter = ({
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
  logError = error => console.error(error),
}) => {
  if (!pool || typeof pool.connect !== 'function'
      || ![requireDatabase, requireAuth].every(value => typeof value === 'function')
      || typeof requirePermission !== 'function'
      || typeof audit !== 'function'
      || typeof importErrorRowSchema?.safeParse !== 'function'
      || typeof parseBoolean !== 'function'
      || typeof collectDuplicateImportRows !== 'function'
      || typeof resolveImportApplyRowNumbers !== 'function'
      || typeof attachImportErrorSourceIdentifiers !== 'function'
      || typeof logError !== 'function') {
    throw new TypeError('Project import routes require the database, authorization guards, and shared import/audit helpers.');
  }

  const rowSchema = z.object({
    projectCode: z.string().min(1),
    name: z.string().min(1),
    clientId: z.string().optional(),
    client: z.string().min(1),
    managerId: z.string().min(1),
    startDate: strictIsoDateSchema,
    endDate: strictIsoDateSchema,
    // CSV templates use empty cells for optional enum values. Normalize only
    // blank cells; nonblank invalid values remain schema errors.
    status: optionalImportEnum(['Proposed', 'Active', 'On Hold', 'Completed']),
    billable: z.union([z.boolean(), z.string()]).optional(),
    projectType: z.string().optional(),
    country: z.string().optional(),
    notes: z.string().optional(),
  });
  const legacySchema = z.object({
    fileName: z.string().min(1),
    rows: z.array(rowSchema).min(1),
    totalRows: z.number().int().min(0).optional(),
    clientErrors: z.array(importErrorRowSchema).optional(),
  });
  const versionedSchema = legacySchema.extend({
    // Empty input is useful for a genuine server-side dry run when client
    // preflight has rejected every row. Legacy requests and versioned applies
    // retain the non-empty-row requirement.
    rows: z.array(rowSchema),
    schemaVersion: z.literal(PROJECT_IMPORT_SCHEMA_VERSION),
    dryRun: z.boolean().default(false),
  }).superRefine((data, context) => {
    if (!data.dryRun && data.rows.length === 0) {
      context.addIssue({code: z.ZodIssueCode.custom, path: ['rows'], message: 'At least one valid row is required to apply an import.'});
    }
  });

  const router = Router();
  router.post('/imports/projects/apply', requireDatabase, requireAuth, requirePermission('imports.manage'), async (req, res) => {
    const versioned = req.apiVersion === 'v1';
    let idempotencyKey = null;
    let actorId = null;
    if (versioned) {
      const rawKey = req.get?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
      if (typeof rawKey !== 'string' || rawKey.length === 0) {
        res.status(400).json({error: {code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'The Idempotency-Key header is required.'}});
        return;
      }
      idempotencyKey = normalizeIdempotencyKey(rawKey);
      if (!idempotencyKey) {
        res.status(400).json({error: {code: 'INVALID_IDEMPOTENCY_KEY', message: 'The Idempotency-Key header is invalid.'}});
        return;
      }
      if (!req.body?.schemaVersion) {
        res.status(400).json({error: {code: 'SCHEMA_VERSION_REQUIRED', message: 'A project import schema version is required.'}});
        return;
      }
      if (req.body.schemaVersion !== PROJECT_IMPORT_SCHEMA_VERSION) {
        res.status(400).json({error: {code: 'UNSUPPORTED_SCHEMA_VERSION', message: 'The project import schema version is not supported.'}});
        return;
      }
      actorId = typeof req.user?.sub === 'string' || typeof req.user?.sub === 'number'
        ? String(req.user.sub)
        : '';
      if (!actorId) {
        res.status(401).json({error: {code: 'AUTHENTICATION_REQUIRED', message: 'An authenticated account is required.'}});
        return;
      }
    }

    const parsed = (versioned ? versionedSchema : legacySchema).safeParse(req.body);
    if (!parsed.success) {
      if (versioned) {
        res.status(400).json({error: {code: 'INVALID_IMPORT_REQUEST', message: 'The project import request is invalid.'}});
      } else {
        res.status(400).json({error: parsed.error.flatten()});
      }
      return;
    }

    const clientErrors = parsed.data.clientErrors || [];
    const {rowNumbers, mappingIsReliable} = resolveImportApplyRowNumbers({
      rows: parsed.data.rows,
      totalRows: parsed.data.totalRows,
      clientErrors,
    });
    const duplicateImportRows = collectDuplicateImportRows(parsed.data.rows, row => [
      {field: 'projectCode', value: row.projectCode, label: 'project code'},
    ], index => rowNumbers[index]);
    const errors = [...clientErrors, ...duplicateImportRows.errors];
    const importBatchId = randomUUID();
    const dryRun = versioned && parsed.data.dryRun;
    const scope = req.organizationScope;
    const canonicalRequest = {
      ...parsed.data,
      totalRows: parsed.data.totalRows ?? parsed.data.rows.length,
      clientErrors,
    };
    const requestHash = versioned ? hashImportRequest(canonicalRequest) : null;
    let client;
    let transactionOpen = false;
    let saved = 0;
    try {
      client = await pool.connect();
      await client.query('begin');
      transactionOpen = true;

      if (versioned) {
        const lockKey = createScopedIdempotencyLockKey({
          organizationId: scope.organizationId,
          legalEntityId: scope.legalEntityId,
          actorId,
          channel: 'Project Master',
          idempotencyKey,
        });
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
        const existing = await client.query(
          'select request_hash, batch_id from import_export_idempotency where organization_id=$1 and legal_entity_id=$2 and actor_id=$3 and channel=$4 and idempotency_key=$5',
          [scope.organizationId, scope.legalEntityId, actorId, 'Project Master', idempotencyKey],
        );
        if (existing.rowCount > 0) {
          if (existing.rows[0].request_hash !== requestHash) {
            await client.query('rollback');
            transactionOpen = false;
            res.status(409).json({error: {code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request.'}});
            return;
          }
          const previousBatch = await client.query(
            'select * from import_export_logs where id=$1 and organization_id=$2 and legal_entity_id=$3 and channel=$4 limit 1',
            [existing.rows[0].batch_id, scope.organizationId, scope.legalEntityId, 'Project Master'],
          );
          if (previousBatch.rowCount !== 1) throw new Error('Idempotency record has no matching scoped import batch.');
          await client.query('commit');
          transactionOpen = false;
          res.json(responseFromBatch(previousBatch.rows[0], true));
          return;
        }
      }

      const projectCodeLockKeys = [...new Set(parsed.data.rows
        .filter((_, index) => !duplicateImportRows.duplicateRowNumbers.has(rowNumbers[index]))
        .map(row => createProjectCodeLockKey({
          organizationId: scope.organizationId,
          projectCode: row.projectCode,
        })))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const projectCodeLockKey of projectCodeLockKeys) {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [projectCodeLockKey]);
      }

      for (const [index, row] of parsed.data.rows.entries()) {
        const rowNumber = rowNumbers[index];
        if (duplicateImportRows.duplicateRowNumbers.has(rowNumber)) continue;
        const rowErrors = [];
        if (row.endDate < row.startDate) {
          rowErrors.push({rowNumber, field: 'endDate', message: 'End date must be on or after start date.'});
        }
        const clientRecord = (versioned && row.clientId
          ? (await client.query(
            'select id, name, status from clients where id=$1 and organization_id=$2 and legal_entity_id=$3 limit 1',
            [row.clientId, scope.organizationId, scope.legalEntityId],
          )).rows[0]
          : (await client.query(
            'select id, name, status from clients where (($1::text is not null and id = $1) or lower(name) = lower($2)) and organization_id=$3 and legal_entity_id=$4 limit 1',
            [row.clientId || null, row.client, scope.organizationId, scope.legalEntityId],
          )).rows[0]);
        if (!clientRecord || clientRecord.status !== 'Active') {
          rowErrors.push({rowNumber, field: 'client', message: 'Project must reference an active client.'});
        }
        const manager = (await client.query(
          'select id, name, status from employees where (id = $1 or employee_id = $1) and status = \'Active\' and organization_id=$2 and legal_entity_id=$3 limit 1',
          [row.managerId, scope.organizationId, scope.legalEntityId],
        )).rows[0];
        if (!manager) {
          rowErrors.push({rowNumber, field: 'managerId', message: 'Project manager employee record does not exist or is exited.'});
        }
        if (rowErrors.length > 0) {
          errors.push(...rowErrors);
          continue;
        }

        const previous = (await client.query(
          'select * from projects where project_code=$1 and organization_id=$2 and legal_entity_id=$3 limit 1 for update',
          [row.projectCode, scope.organizationId, scope.legalEntityId],
        )).rows[0];
        const crossLegalCollision = !previous && (await client.query(
          'select 1 from projects where project_code=$1 and organization_id=$2 and legal_entity_id<>$3 limit 1',
          [row.projectCode, scope.organizationId, scope.legalEntityId],
        )).rows[0];
        if (crossLegalCollision) {
          errors.push({
            rowNumber,
            field: 'projectCode',
            message: versioned
              ? 'Project code is not available in the authorized scope.'
              : 'Project code belongs to another legal entity in this organization.',
            code: 'PROJECT_SCOPE_CONFLICT',
          });
          continue;
        }
        if (dryRun) {
          saved += 1;
          continue;
        }

        const result = await client.query(
          'insert into projects (id, project_code, name, client_id, client, manager_id, manager_name, start_date, end_date, status, billable, project_type, country, notes, organization_id, legal_entity_id) values (coalesce($1, \'p-\' || gen_random_uuid()::text), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict (organization_id,project_code) do update set name=excluded.name, client_id=excluded.client_id, client=excluded.client, manager_id=excluded.manager_id, manager_name=excluded.manager_name, start_date=excluded.start_date, end_date=excluded.end_date, status=excluded.status, billable=excluded.billable, project_type=excluded.project_type, country=excluded.country, notes=excluded.notes, updated_at=now() where projects.organization_id=excluded.organization_id and projects.legal_entity_id=excluded.legal_entity_id returning *',
          [
            previous?.id || null,
            row.projectCode,
            row.name,
            clientRecord.id,
            clientRecord.name,
            manager.id,
            manager.name,
            row.startDate,
            row.endDate,
            row.status || previous?.status || 'Proposed',
            parseBoolean(row.billable, previous?.billable ?? true),
            row.projectType || previous?.project_type || null,
            row.country || previous?.country || null,
            row.notes || previous?.notes || null,
            scope.organizationId,
            scope.legalEntityId,
          ],
        );
        if (result.rowCount === 0) {
          errors.push({
            rowNumber,
            field: 'projectCode',
            message: versioned
              ? 'Project code is not available in the authorized scope.'
              : 'Project code belongs to another legal entity in this organization.',
            code: 'PROJECT_SCOPE_CONFLICT',
          });
          continue;
        }
        const project = result.rows[0];
        await audit(client, req, {
          module: 'Import',
          action: previous ? 'Import Update Project' : 'Import Create Project',
          entityType: 'Project',
          entityId: project.id,
          oldValue: previous,
          newValue: project,
          details: (previous ? 'Updated' : 'Created') + ' project ' + project.project_code + ' from ' + parsed.data.fileName,
          source: 'Project Master CSV',
          importBatchId,
          sourceIdentifier: row.projectCode,
          importProcessingResult: 'Success',
        });
        saved += 1;
      }

      const responseErrors = attachImportErrorSourceIdentifiers({
        errors, clientErrors, rows: parsed.data.rows, rowNumbers, mappingIsReliable,
        sourceIdentifierForRow: row => row.projectCode,
      });
      const status = dryRun ? 'Dry Run' : saved === 0 ? 'Failed' : errors.length > 0 ? 'Partial' : 'Success';
      const totalRows = parsed.data.totalRows ?? parsed.data.rows.length;
      if (dryRun) {
        await audit(client, req, {
          module: 'Import',
          action: 'Dry Run Project Import',
          entityType: 'ImportBatch',
          entityId: importBatchId,
          oldValue: null,
          newValue: {schemaVersion: parsed.data.schemaVersion, status, totalRows, validRows: saved, errorRows: errors.length},
          details: 'Validated project import ' + parsed.data.fileName + ' without applying project rows',
          source: 'Project Master CSV',
          importBatchId,
          importProcessingResult: 'Dry Run',
        });
      }
      const logResult = await client.query(
        'insert into import_export_logs (id, operation, channel, file_name, status, total_rows, valid_rows, error_rows, errors, user_name, organization_id, legal_entity_id, schema_version, dry_run) values ($1,\'Import\',\'Project Master\',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',
        [
          importBatchId,
          parsed.data.fileName,
          status,
          totalRows,
          saved,
          errors.length,
          errors.length ? JSON.stringify(responseErrors) : null,
          req.user.username,
          scope.organizationId,
          scope.legalEntityId,
          versioned ? parsed.data.schemaVersion : null,
          dryRun,
        ],
      );
      if (versioned) {
        await client.query(
          'insert into import_export_idempotency (organization_id, legal_entity_id, actor_id, channel, idempotency_key, request_hash, batch_id) values ($1,$2,$3,\'Project Master\',$4,$5,$6)',
          [scope.organizationId, scope.legalEntityId, actorId, idempotencyKey, requestHash, importBatchId],
        );
      }
      await client.query('commit');
      transactionOpen = false;
      res.json(responseFromBatch(logResult.rows[0], versioned));
    } catch (error) {
      if (client && transactionOpen) {
        try {
          await client.query('rollback');
        } catch {
          // Preserve the original failure.
        }
      }
      logError(error);
      if (versioned) {
        res.status(500).json({error: {code: 'PROJECT_IMPORT_FAILED', message: 'The project import could not be completed.'}});
      } else {
        res.status(500).json({error: 'Project import apply failed'});
      }
    } finally {
      client?.release();
    }
  });

  return router;
};
