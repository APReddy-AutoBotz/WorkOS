import { invoiceDraftTotal } from '../../../shared/invoice-batch-draft.mjs';

// Read a bounded, scope-filtered population in the caller's repeatable-read transaction.
// Suppress an item if any linked batch contains a worker outside the caller's scope;
// neither an occupancy nor a historical batch may disclose that worker indirectly.
export const readBillingReconciliation = async (client, req, engagementId, options) => {
  const args = [req.organizationScope.organizationId, req.organizationScope.legalEntityId, engagementId];
  const visible = options.buildEmployeeScopeWhere(req, args, 'worker');
  const visibleArgs = [...args];
  const batchVisible = options.buildEmployeeScopeWhere(req, args, 'batch_worker');
  const rows = (
    await client.query(
      `
    select item.id as "itemId", item.version as "itemVersion", ev.id as "eventId",
      ev.version as "eventVersion", ev.source_type as "sourceType", ev.snapshot_id as "snapshotId",
      ev.instance_id as "eligibilityApprovalId", ev.decision_id as "eligibilityDecisionId",
      ev.client_id as "clientId", ev.contract_id as "contractId", ev.engagement_id as "engagementId",
      ev.eligible_on::text as "eligibleOn", ev.currency, ev.amount::text as amount,
      ev.billing_evidence as evidence,
      v.result->>'billableValue' as "sourceAmount",v.result->>'currency' as "sourceCurrency",
      coalesce(v.result->>'currency'=ev.currency and (v.result->>'billableValue')::numeric=ev.amount,false) as "sourceMatches",
      tm_billing_source_valid(ev.organization_id,ev.legal_entity_id,ev.engagement_id,ev.snapshot_id) as "sourceCurrent",
      occ.batch_id as "batchId", occ.line_id as "lineId", line.request_id as "acquisitionRequestId",
      line.operation_id as "acquisitionOperationId",line.amount::text as "lineAmount",line.currency as "lineCurrency",
      case when occ.batch_id is not null then invoice_batch_governed_state(occ.batch_id) end as "batchState",
      art.id as "artifactId", art.sha256 as "artifactHash", conf.id as "confirmationId",
      case when occ.line_id is null then true else coalesce(
        line.id=occ.line_id and line.batch_id=occ.batch_id and line.item_id=item.id
        and line.item_version=item.version and line.event_id=ev.id and line.snapshot_id=ev.snapshot_id
        and line.organization_id=ev.organization_id and line.legal_entity_id=ev.legal_entity_id
        and line.currency=ev.currency and line.amount=ev.amount and line.billing_evidence=ev.billing_evidence
        and batch.organization_id=ev.organization_id and batch.legal_entity_id=ev.legal_entity_id
        and batch.client_id=ev.client_id and batch.contract_id=ev.contract_id
        and batch.engagement_id=ev.engagement_id and batch.currency=ev.currency,false) end as "lineMatches",
      case when art.id is null then conf.id is null else coalesce(
        art.sha256=encode(digest(art.payload,'sha256'),'hex') and art.organization_id=ev.organization_id
        and art.legal_entity_id=ev.legal_entity_id and art.currency=batch.currency
        and art.line_count=(select count(*) from invoice_draft_lines export_line where export_line.batch_id=batch.id)
        and art.total=(select sum(export_line.amount) from invoice_draft_lines export_line where export_line.batch_id=batch.id)
        and (conf.id is null or (conf.artifact_id=art.id and conf.artifact_sha256=art.sha256
          and conf.currency=art.currency and conf.total=art.total)),false) end as "artifactMatches",
      (select count(*)::int from invoice_draft_lines hist where hist.item_id=item.id and hist.item_version=item.version
       and not exists(select 1 from invoice_draft_occupancies current_occ where current_occ.line_id=hist.id)) as "historicalLineCount",
      coalesce((select jsonb_agg(jsonb_build_object('lineId',hist.id,'batchId',hist.batch_id,
        'batchState',invoice_batch_governed_state(hist.batch_id),'amount',hist.amount::text,'currency',hist.currency,
        'matches',hist.event_id=ev.id and hist.snapshot_id=ev.snapshot_id and hist.amount=ev.amount and hist.currency=ev.currency) order by hist.created_at,hist.id)
        from invoice_draft_lines hist where hist.item_id=item.id and hist.item_version=item.version
        and not exists(select 1 from invoice_draft_occupancies current_occ where current_occ.line_id=hist.id)), '[]'::jsonb) as history
    from approved_unbilled_items item
    join billing_eligibility_events ev on ev.id=item.event_id
    join commercial_tm_valuations v on v.id=ev.snapshot_id
    join work_submission_evidence sub on sub.id=v.submission_id
    join timesheets h on h.id=sub.timesheet_id
    join employees worker on worker.id=h.employee_id
    left join invoice_draft_occupancies occ on occ.item_id=item.id and occ.item_version=item.version
    left join invoice_draft_lines line on line.id=occ.line_id
    left join invoice_draft_batches batch on batch.id=occ.batch_id
    left join invoice_csv_artifacts art on art.batch_id=occ.batch_id
    left join invoice_batch_confirmations conf on conf.batch_id=occ.batch_id
    where item.organization_id=$1 and item.legal_entity_id=$2 and ev.organization_id=$1
      and ev.legal_entity_id=$2 and ev.engagement_id=$3 and (${visible})
      and not exists (
        select 1 from invoice_draft_lines related
        join invoice_draft_lines member on member.batch_id=related.batch_id
        join commercial_tm_valuations batch_v on batch_v.id=member.snapshot_id
        join work_submission_evidence batch_sub on batch_sub.id=batch_v.submission_id
        join timesheets batch_h on batch_h.id=batch_sub.timesheet_id
        left join employees batch_worker on batch_worker.id=batch_h.employee_id
        where related.item_id=item.id and related.item_version=item.version
          and not coalesce((${batchVisible}),false)
      )
    order by item.id limit 501`,
      args,
    )
  ).rows;
  if (rows.length > 500) {
    throw Object.assign(
      new Error('This engagement has more than 500 visible items. A complete report is unavailable.'),
      { statusCode: 422, code: 'BILLING_RECONCILIATION_LIMIT' },
    );
  }
  const missing = (
    await client.query(
      `
    select ev.id as "eventId",ev.snapshot_id as "snapshotId",ev.currency,ev.amount::text as amount,
      v.result->>'billableValue' as "sourceAmount",v.result->>'currency' as "sourceCurrency"
    from billing_eligibility_events ev
    join commercial_tm_valuations v on v.id=ev.snapshot_id
    join work_submission_evidence sub on sub.id=v.submission_id
    join timesheets h on h.id=sub.timesheet_id
    join employees worker on worker.id=h.employee_id
    where ev.organization_id=$1 and ev.legal_entity_id=$2 and ev.engagement_id=$3 and (${visible})
      and not exists(select 1 from approved_unbilled_items item where item.event_id=ev.id)
    order by ev.id limit 501`,
      visibleArgs,
    )
  ).rows;
  if (rows.length + missing.length > 500) {
    throw Object.assign(
      new Error('This engagement has more than 500 visible events. A complete report is unavailable.'),
      { statusCode: 422, code: 'BILLING_RECONCILIATION_LIMIT' },
    );
  }
  const grouped = new Map();
  const controlGroups = new Map();
  const addControl = (currency, boundary, amount) => {
    const key = `${currency}:${boundary}`;
    if (!controlGroups.has(key)) controlGroups.set(key, { currency, boundary, amounts: [] });
    controlGroups.get(key).amounts.push(amount);
  };
  for (const row of rows) {
    row.status = row.batchId ? 'OCCUPIED' : row.sourceCurrent ? 'AVAILABLE' : 'SOURCE_UNAVAILABLE';
    row.controlOk =
      row.sourceMatches &&
      row.lineMatches &&
      row.artifactMatches &&
      row.history.every((line) => line.batchState === 'Cancelled' && line.matches) &&
      (!row.batchId ||
        ['Draft', 'Under Review', 'Approved', 'Exported', 'Billed/Confirmed'].includes(row.batchState)) &&
      (!['Exported', 'Billed/Confirmed'].includes(row.batchState) || !!row.artifactId) &&
      (row.batchState !== 'Billed/Confirmed' || !!row.confirmationId);
    const key = `${row.currency}:${row.status}`;
    if (!grouped.has(key)) grouped.set(key, { currency: row.currency, status: row.status, amounts: [] });
    grouped.get(key).amounts.push(row.amount);
    addControl(row.sourceCurrency, 'EVENT_BACKED_SOURCE', row.sourceAmount);
    addControl(row.currency, 'ELIGIBILITY_EVENT', row.amount);
    addControl(row.currency, 'REGISTER_ITEM', row.amount);
    if (row.batchId) {
      addControl(row.currency, 'CURRENT_OCCUPANCY', row.amount);
      if (row.lineCurrency && row.lineAmount) {
        addControl(row.lineCurrency, 'CURRENT_LINE', row.lineAmount);
        if (['Exported', 'Billed/Confirmed'].includes(row.batchState))
          addControl(row.lineCurrency, 'EXPORTED_LINE', row.lineAmount);
        if (row.batchState === 'Billed/Confirmed')
          addControl(row.lineCurrency, 'MANUALLY_CONFIRMED_LINE', row.lineAmount);
      }
    }
    for (const line of row.history)
      if (line.batchState === 'Cancelled') addControl(line.currency, 'HISTORICAL_RELEASED_LINE', line.amount);
  }
  for (const event of missing) {
    addControl(event.sourceCurrency, 'EVENT_BACKED_SOURCE', event.sourceAmount);
    addControl(event.currency, 'ELIGIBILITY_EVENT', event.amount);
  }
  const totals = [...grouped.values()]
    .map(({ currency, status, amounts }) => ({ currency, status, ...invoiceDraftTotal(amounts) }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.status.localeCompare(b.status));
  const controls = [...controlGroups.values()]
    .map(({ currency, boundary, amounts }) => ({ currency, boundary, ...invoiceDraftTotal(amounts) }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.boundary.localeCompare(b.boundary));
  const asOf = (await client.query('select transaction_timestamp() as ts')).rows[0].ts;
  return {
    asOf,
    engagementId,
    items: rows,
    missingEvents: missing,
    totals,
    controls,
    exceptionCount: rows.filter((row) => !row.controlOk).length + missing.length,
  };
};
