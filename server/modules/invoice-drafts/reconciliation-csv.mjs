import { quoteCsvCell } from '../../../shared/csv-cell.mjs';
import { capacityCanonical, capacityHash } from '../planning/worker-capacity-service.mjs';

export const RECONCILIATION_VERSION = 'workos.tm-reconciliation/1';
export const MILESTONE_RECONCILIATION_VERSION = 'workos.milestone-reconciliation/1';
export const reconciliationToken = (scope, report) =>
  capacityHash(
    capacityCanonical({
      version: report.version ?? RECONCILIATION_VERSION,
      scope,
      engagementId: report.engagementId,
      items: report.items,
      missingEvents: report.missingEvents,
      totals: report.totals,
      controls: report.controls,
      exceptionCount: report.exceptionCount,
    }),
  );

export const reconciliationCsv = (scope, report, token) => {
  const fields = [
    'record_type',
    'report_version',
    'organization_id',
    'legal_entity_id',
    'engagement_id',
    'as_of_utc',
    'source_token',
    'currency',
    'boundary_or_status',
    'count',
    'amount',
    'item_id',
    'event_id',
    report.version === MILESTONE_RECONCILIATION_VERSION ? 'milestone_id' : 'snapshot_id',
    'approval_id',
    'decision_id',
    'batch_id',
    'line_id',
    'batch_state',
    'artifact_id',
    'artifact_sha256',
    'manual_confirmation_id',
    'control_ok',
  ];
  const base = [
    report.version ?? RECONCILIATION_VERSION,
    scope.organizationId,
    scope.legalEntityId,
    report.engagementId,
    new Date(report.asOf).toISOString(),
    token,
  ];
  const encode = (values) =>
    [...values, ...Array(fields.length - values.length).fill('')].map(quoteCsvCell).join(',');
  const lines = [encode(fields), encode(['REPORT', ...base])];
  for (const control of report.controls)
    lines.push(
      encode(['CONTROL', ...base, control.currency, control.boundary, control.lineCount, control.amount]),
    );
  for (const item of report.items)
    lines.push(
      encode([
        'ITEM',
        ...base,
        item.currency,
        item.status,
        1,
        item.amount,
        item.itemId,
        item.eventId,
        item.milestoneId ?? item.snapshotId,
        item.eligibilityApprovalId,
        item.eligibilityDecisionId,
        item.batchId,
        item.lineId,
        item.batchState,
        item.artifactId,
        item.artifactHash,
        item.confirmationId,
        item.controlOk,
      ]),
    );
  for (const item of report.items)
    for (const line of item.history)
      lines.push(
        encode([
          'HISTORY',
          ...base,
          line.currency,
          'HISTORICAL_RELEASED_LINE',
          1,
          line.amount,
          item.itemId,
          item.eventId,
          item.milestoneId ?? item.snapshotId,
          item.eligibilityApprovalId,
          item.eligibilityDecisionId,
          line.batchId,
          line.lineId,
          line.batchState,
          '',
          '',
          '',
          line.matches,
        ]),
      );
  return lines.join('\r\n') + '\r\n';
};

export const portfolioReconciliationCsv = (scope, report) => {
  const columns = [
    'record_type',
    'report_version',
    'organization_id',
    'legal_entity_id',
    'eligible_from',
    'eligible_through',
    'source_models',
    'as_of_utc',
    'source_token',
    'currency',
    'boundary_or_status',
    'count',
    'amount',
  ];
  const metadata = [
    report.version,
    scope.organizationId,
    scope.legalEntityId,
    report.start,
    report.end,
    report.source,
    new Date(report.asOf).toISOString(),
    report.reportToken,
  ];
  const charges=!['both','time_and_materials','milestone'].includes(report.source);
  if (charges) columns.push('expected_records','exceptions');
  const rows = [columns, ['REPORT', ...metadata, '', '', '', '',...(charges?['','']:[])]];
  for (const row of report.controls)
    rows.push(['CONTROL', ...metadata, row.currency, row.boundary, row.lineCount, row.amount,...(charges?[row.expected,row.exceptions]:[])]);
  for (const row of report.totals)
    rows.push(['REGISTER_STATE', ...metadata, row.currency, row.status, row.lineCount, row.amount,...(charges?['','']:[])]);
  return rows.map((cells) => cells.map(quoteCsvCell).join(',')).join('\r\n') + '\r\n';
};
