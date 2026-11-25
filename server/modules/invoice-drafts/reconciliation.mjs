import { createHash } from 'node:crypto';
import { reconciliationToken } from './reconciliation-csv.mjs';
import { decimalDifference, sumHours } from '../../../shared/work-hours.mjs';
// Keep approved credits signed while reusing the decimal-safe quantity operations.
const netAmount = (amounts) => decimalDifference(
  sumHours(amounts.filter(amount => !amount.startsWith('-'))),
  sumHours(amounts.filter(amount => amount.startsWith('-')).map(amount => amount.slice(1))),
);

// Read a bounded, scope-filtered population in the caller's repeatable-read transaction.
// Suppress an item if any linked batch contains a worker outside the caller's scope;
// neither an occupancy nor a historical batch may disclose that worker indirectly.
export const readBillingReconciliation = async (
  client,
  req,
  engagementId,
  options,
  model = 'time_and_materials',
  page = null,
) => {
  const milestone = model === 'milestone';
  if (!milestone && model !== 'time_and_materials') throw new Error('Unsupported reconciliation model.');
  const args = [req.organizationScope.organizationId, req.organizationScope.legalEntityId];
  if (page) args.push(page.start, page.end, page.afterItem);
  else args.push(engagementId);
  const population = page
    ? `ev.eligible_on between $3::date and $4::date and exists(select 1 from commercial_engagements eng where eng.id=ev.engagement_id and eng.organization_id=ev.organization_id and eng.legal_entity_id=ev.legal_entity_id and eng.model='${model}')`
    : 'ev.engagement_id=$3';

  const visible = milestone ? 'true' : options.buildEmployeeScopeWhere(req, args, 'worker');
  const visibleArgs = [...args];
  if (page) visibleArgs[4] = page.afterEvent;
  const batchVisible = milestone ? null : options.buildEmployeeScopeWhere(req, args, 'batch_worker');
  const relatedScope = milestone
    ? `and not exists (
    select 1 from invoice_draft_lines related join invoice_draft_batches linked on linked.id=related.batch_id
    where related.item_id=item.id and related.item_version=item.version and
      (linked.source_type<>related.source_type or linked.organization_id<>item.organization_id
       or linked.legal_entity_id<>item.legal_entity_id or linked.engagement_id<>ev.engagement_id))`
    : `and not exists (
        select 1 from invoice_draft_lines related
        join invoice_draft_lines member on member.batch_id=related.batch_id
        join billing_eligibility_events member_event on member_event.id=member.event_id
        join billing_eligibility_events member_charge on member_charge.id=coalesce(member_event.reverses_event_id,member_event.id)
        left join commercial_tm_valuations batch_v on batch_v.id=member_charge.snapshot_id
        left join work_submission_evidence batch_sub on batch_sub.id=batch_v.submission_id
        left join timesheets batch_h on batch_h.id=batch_sub.timesheet_id
        left join employees batch_worker on batch_worker.id=batch_h.employee_id
        where (related.item_id=item.id and related.item_version=item.version or related.event_id=ev.reverses_event_id)
          and not coalesce((${batchVisible}),false)
      )`;
  const sourceJoins = milestone
    ? `
    join milestone_billing_instances review on review.id=original.milestone_instance_id
      and review.organization_id=ev.organization_id and review.legal_entity_id=ev.legal_entity_id
      and review.engagement_id=ev.engagement_id
    join commercial_milestones m on m.id=review.milestone_id and m.engagement_id=review.engagement_id
      and m.organization_id=review.organization_id and m.legal_entity_id=review.legal_entity_id
    join milestone_billing_transitions decision on decision.id=original.milestone_decision_id and decision.instance_id=review.id
    join milestone_billing_policies policy on policy.id=review.policy_id`
    : `join commercial_tm_valuations v on v.id=original.snapshot_id
    join work_submission_evidence sub on sub.id=v.submission_id
    join timesheets h on h.id=sub.timesheet_id
    join employees worker on worker.id=h.employee_id`;
  const sourceIds = milestone
    ? 'm.id as "milestoneId", null::uuid as "snapshotId"'
    : 'original.snapshot_id as "snapshotId"';
  const approvalId = milestone ? 'ev.milestone_instance_id' : 'ev.instance_id';
  const decisionId = milestone ? 'ev.milestone_decision_id' : 'ev.decision_id';
  const sourceAmount = milestone ? 'm.amount::text' : "v.result->>'billableValue'";
  const sourceCurrency = milestone ? 'm.currency' : "v.result->>'currency'";
  const sourceType = milestone ? 'MILESTONE_ACCEPTANCE' : 'TM_SNAPSHOT';
  const sourceCurrent = milestone
    ? 'milestone_billing_source_valid(review.organization_id,review.legal_entity_id,review.engagement_id,review.milestone_id,review.engagement_lifecycle_id,review.contract_lifecycle_id)'
    : 'tm_billing_source_valid(ev.organization_id,ev.legal_entity_id,ev.engagement_id,ev.snapshot_id)';
  const milestoneChecks = milestone
    ? `coalesce(case when ev.reverses_event_id is not null then credit.evidence=ev.billing_evidence else decision.decision='Approved'
    and decision.sequence=jsonb_array_length(policy.definition->'stages')
    and ev.billing_evidence->>'milestoneId'=m.id and ev.billing_evidence->>'decisionId'=decision.id::text
    and ev.billing_evidence->'evidence'=review.evidence
    and ev.billing_evidence->>'policyId'=policy.id::text
    and ev.billing_evidence->>'engagementLifecycleId'=review.engagement_lifecycle_id
    and ev.billing_evidence->>'contractLifecycleId'=review.contract_lifecycle_id end,false) as "acceptanceMatches",`
    : '';
  // Historical upgrade runs can read reports before named adjustments are installed.
  const creditSchema = await client.query("select to_regprocedure('invoice_credit_source(uuid)') is not null as named");
  const creditSource = creditSchema.rows[0].named ? 'invoice_credit_source' : 'full_line_reversal_source';
  const sourceEvidence = `
    join billing_eligibility_events original on original.id=coalesce(ev.reverses_event_id,ev.id)
      and original.organization_id=ev.organization_id and original.legal_entity_id=ev.legal_entity_id
      and original.engagement_id=ev.engagement_id and original.source_type='${sourceType}'
    ${sourceJoins}
    left join lateral ${creditSource}(case when ev.reverses_event_id is not null
      then (ev.billing_evidence->>'reviewId')::uuid end) credit on credit.original_event=original.id
      and credit.final_decision=ev.reversal_decision_id and credit.organization_id=ev.organization_id
      and credit.legal_entity_id=ev.legal_entity_id and credit.engagement_id=ev.engagement_id`;
  const amount = `case when ev.reverses_event_id is null then ${sourceAmount} else credit.amount::text end`;
  const currency = `case when ev.reverses_event_id is null then ${sourceCurrency} else credit.currency end`;
  const rows = (
    await client.query(
      `
    select item.id as "itemId", item.version as "itemVersion", ev.id as "eventId",
      ev.version as "eventVersion", ev.source_type as "sourceType", ${sourceIds},
      case when ev.reverses_event_id is null then ${approvalId} else (ev.billing_evidence->>'reviewId')::uuid end as "eligibilityApprovalId", coalesce(ev.reversal_decision_id,${decisionId}) as "eligibilityDecisionId",
      ev.client_id as "clientId", ev.contract_id as "contractId", ev.engagement_id as "engagementId",
      ev.eligible_on::text as "eligibleOn", ev.currency, ev.amount::text as amount,
      ev.billing_evidence as evidence,
      (${amount}) as "sourceAmount",(${currency}) as "sourceCurrency",
      coalesce((${currency})=ev.currency and (${amount})::numeric=ev.amount,false) as "sourceMatches",
      ${milestoneChecks} case when ev.reverses_event_id is null then ${sourceCurrent} else credit.final_decision is not null end as "sourceCurrent",
      occ.batch_id as "batchId", occ.line_id as "lineId", line.request_id as "acquisitionRequestId",
      line.operation_id as "acquisitionOperationId",line.amount::text as "lineAmount",line.currency as "lineCurrency",
      case when occ.batch_id is not null then invoice_batch_governed_state(occ.batch_id) end as "batchState",
      art.id as "artifactId", art.sha256 as "artifactHash", conf.id as "confirmationId",
      case when occ.line_id is null then true else coalesce(
        line.id=occ.line_id and line.batch_id=occ.batch_id and line.item_id=item.id
        and line.item_version=item.version and line.event_id=ev.id and line.snapshot_id is not distinct from ev.snapshot_id
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
        'matches',hist.event_id=ev.id and hist.snapshot_id is not distinct from ev.snapshot_id and hist.billing_evidence=ev.billing_evidence and hist.amount=ev.amount and hist.currency=ev.currency) order by hist.created_at,hist.id)
        from invoice_draft_lines hist where hist.item_id=item.id and hist.item_version=item.version
        and not exists(select 1 from invoice_draft_occupancies current_occ where current_occ.line_id=hist.id)), '[]'::jsonb) as history
    from approved_unbilled_items item
    join billing_eligibility_events ev on ev.id=item.event_id
    ${sourceEvidence}
    left join invoice_draft_occupancies occ on occ.item_id=item.id and occ.item_version=item.version
    left join invoice_draft_lines line on line.id=occ.line_id
    left join invoice_draft_batches batch on batch.id=occ.batch_id
    left join invoice_csv_artifacts art on art.batch_id=occ.batch_id
    left join invoice_batch_confirmations conf on conf.batch_id=occ.batch_id
    where item.organization_id=$1 and item.legal_entity_id=$2 and ev.organization_id=$1
      and ev.legal_entity_id=$2 and ${population} and ev.source_type in ('${sourceType}','FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and (${visible})
      ${relatedScope} ${page ? 'and ($5::uuid is null or item.id>$5)' : ''}
    order by item.id limit 501`,
      args,
    )
  ).rows;
  if (!page && rows.length > 500) {
    throw Object.assign(
      new Error('This engagement has more than 500 visible items. A complete report is unavailable.'),
      { statusCode: 422, code: 'BILLING_RECONCILIATION_LIMIT' },
    );
  }
  const missing = (
    await client.query(
      `
    select ev.id as "eventId",${sourceIds},ev.currency,ev.amount::text as amount,
      (${amount}) as "sourceAmount",(${currency}) as "sourceCurrency"
    from billing_eligibility_events ev
    ${sourceEvidence}
    where ev.organization_id=$1 and ev.legal_entity_id=$2 and ${population} and ev.source_type in ('${sourceType}','FULL_LINE_REVERSAL','CHARGE_ADJUSTMENT') and (${visible})
      and not exists(select 1 from approved_unbilled_items item where item.event_id=ev.id)
      ${page ? 'and ($5::uuid is null or ev.id>$5)' : ''}
    order by ev.id limit 501`,
      visibleArgs,
    )
  ).rows;
  if (!page && rows.length + missing.length > 500) {
    throw Object.assign(
      new Error('This engagement has more than 500 visible events. A complete report is unavailable.'),
      { statusCode: 422, code: 'BILLING_RECONCILIATION_LIMIT' },
    );
  }
  const more = !!page && (rows.length > 500 || missing.length > 500);
  if (page) {
    rows.splice(500);
    missing.splice(500);
  }
  const grouped = new Map();
  const controlGroups = new Map();
  const addControl = (currency, boundary, amount) => {
    if (currency == null || amount == null) return;
    const key = `${currency}:${boundary}`;
    if (!controlGroups.has(key)) controlGroups.set(key, { currency, boundary, amounts: [] });
    controlGroups.get(key).amounts.push(amount);
  };
  for (const row of rows) {
    row.status = row.batchId ? 'OCCUPIED' : row.sourceCurrent ? 'AVAILABLE' : 'SOURCE_UNAVAILABLE';
    row.controlOk =
      row.sourceMatches &&
      (!milestone || row.acceptanceMatches) &&
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
    .map(({ currency, status, amounts }) => ({ currency, status, lineCount: amounts.length, amount: netAmount(amounts) }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.status.localeCompare(b.status));
  const controls = [...controlGroups.values()]
    .map(({ currency, boundary, amounts }) => ({ currency, boundary, lineCount: amounts.length, amount: netAmount(amounts) }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.boundary.localeCompare(b.boundary));
  const asOf = (await client.query('select transaction_timestamp() as ts')).rows[0].ts;
  return {
    asOf,
    engagementId,
    ...(page ? { more } : {}),
    items: rows,
    missingEvents: missing,
    totals,
    controls,
    exceptionCount: rows.filter((row) => !row.controlOk).length + missing.length,
  };
};

export async function readPortfolioReconciliation(
  client,
  req,
  options,
  { start, end, source },
  includeToken = false,
) {
  const fingerprint = includeToken ? createHash('sha256') : null;
  fingerprint?.update(
    JSON.stringify([
      'workos.portfolio-reconciliation/1',
      req.organizationScope.organizationId,
      req.organizationScope.legalEntityId,
      start,
      end,
      source,
    ]),
  );

  const grouped = new Map(),
    boundaries = new Map();
  const add = (target, label, row) => {
    const key = row.currency + ':' + row[label];
    const prior = target.get(key);
    target.set(
      key,
      prior
        ? {
            ...prior,
            amount: netAmount([prior.amount, row.amount]),
            lineCount: prior.lineCount + row.lineCount,
          }
        : row,
    );
  };
  let asOf,
    exceptionCount = 0;
  for (const model of source === 'both' ? ['time_and_materials', 'milestone'] : [source]) {
    let afterItem = null,
      afterEvent = null;
    for (;;) {
      const report = await readBillingReconciliation(client, req, null, options, model, {
        start,
        end,
        afterItem,
        afterEvent,
      });
      if (fingerprint)
        fingerprint.update(
          model +
            ':' +
            reconciliationToken(
              {
                organizationId: req.organizationScope.organizationId,
                legalEntityId: req.organizationScope.legalEntityId,
              },
              report,
            ),
        );
      asOf = report.asOf;
      exceptionCount += report.exceptionCount;
      for (const row of report.totals) add(grouped, 'status', row);
      for (const row of report.controls) add(boundaries, 'boundary', row);
      if (!report.more) break;
      afterItem = report.items.at(-1)?.itemId ?? afterItem;
      afterEvent = report.missingEvents.at(-1)?.eventId ?? afterEvent;
    }
  }
  const sorted = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  return {
    version: 'workos.portfolio-reconciliation/1',
    ...(fingerprint ? { reportToken: fingerprint.digest('hex') } : {}),
    start,
    end,
    source,
    asOf,
    exceptionCount,
    totals: sorted(grouped),
    controls: sorted(boundaries),
  };
}
