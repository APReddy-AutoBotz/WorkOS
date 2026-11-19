import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workApprovalOwner } from '../approvals/work-approval-service.mjs';

const uuid = z.string().uuid();
const params = z.object({ batchId: uuid, lineId: uuid });
const command = z.object({
  expectedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/),
  artifactId: uuid,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  inspectedState: z.enum(['Exported', 'Billed/Confirmed']),
  reason: z.string().trim().min(3).max(1000),
}).strict();
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode, code: 'INVOICE_REVERSAL_REQUEST' });
const fields = 'id,line_id as "lineId",artifact_id as "artifactId",confirmation_id as "confirmationId",reason,actor_id as "actorId",active_role as "activeRole",created_at as "createdAt"';

export function registerLineReversalRequests(router, { handle, authorize, batch, envelope, audit }) {
  const path = '/batches/:batchId/lines/:lineId/reversal-request';
  const inspect = async (c, r, write) => {
    if (!params.safeParse(r.params).success || Object.keys(r.query).length) throw fail(400, 'Select a valid exported line.');
    await authorize(c, r, 'reversal');
    const { row, source } = await batch(c, r, r.params.batchId, write);
    if (!['Exported', 'Billed/Confirmed'].includes(row.state) || !source.lines.some(l => l.lineId === r.params.lineId))
      throw fail(404, 'Exported line unavailable.');
    const artifact = (await c.query(
      'select a.id,a.sha256,cf.id as confirmation from invoice_csv_artifacts a left join invoice_batch_confirmations cf on cf.artifact_id=a.id where a.batch_id=$1',
      [row.id],
    )).rows[0];
    if (!artifact) throw fail(409, 'The retained artifact is unavailable.');
    const existing = (await c.query('select ' + fields + ' from invoice_line_reversal_requests where line_id=$1', [r.params.lineId])).rows[0] ?? null;
    return { row, artifact, existing };
  };
  router.get(path, handle(false, async (c, r) => {
    const { existing } = await inspect(c, r, false);
    return { ...(await envelope(c, r)), request: existing };
  }));
  router.post(path, handle(true, async (c, r) => {
    const parsed = command.safeParse(r.body);
    if (!parsed.success) throw fail(400, 'Supply the inspected export and a reason.');
    const d = parsed.data;
    if (d.expectedOwnerKey !== workApprovalOwner(r)) throw fail(409, 'The account or scope changed.');
    const { row, artifact, existing } = await inspect(c, r, true);
    if (d.artifactId !== artifact.id || d.sha256 !== artifact.sha256) throw fail(409, 'Inspect the retained artifact again.');
    if (existing) {
      if (existing.actorId !== r.user.sub || existing.activeRole !== r.user.activeRole || existing.reason !== d.reason ||
          (existing.confirmationId ? 'Billed/Confirmed' : 'Exported') !== d.inspectedState)
        throw fail(409, 'A full reversal was already requested. Read the recorded request.');
      return { ...(await envelope(c, r)), request: existing, replayed: true };
    }
    const currentState = artifact.confirmation ? 'Billed/Confirmed' : 'Exported';
    if (currentState !== d.inspectedState) throw fail(409, 'The billing state changed. Inspect the batch again.');
    const request = (await c.query(
      'insert into invoice_line_reversal_requests(id,organization_id,legal_entity_id,line_id,artifact_id,confirmation_id,actor_id,active_role,reason,operation_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ' + fields,
      [randomUUID(), row.organization_id, row.legal_entity_id, r.params.lineId, artifact.id, artifact.confirmation, r.user.sub, r.user.activeRole, d.reason, r.operationId],
    )).rows[0];
    await audit(c, r, { module: 'Invoice Corrections', action: 'Request Full Line Reversal', entityType: 'Invoice Line Reversal Request',
      entityId: request.id, reason: d.reason, newValue: { requestId: request.id, lineId: request.lineId, artifactId: artifact.id, confirmationId: artifact.confirmation, batchId: row.id, sha256: artifact.sha256 }, details: 'Finance requested review of the full exported line.' });
    return { ...(await envelope(c, r)), request, replayed: false };
  }));
}
