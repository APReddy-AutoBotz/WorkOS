import type {AuditLog} from '../../types';

export type AuditProvenance = Pick<AuditLog, 'source' | 'activeRole' | 'correlationId' | 'operationId'
  | 'importBatchId' | 'sourceIdentifier' | 'importProcessingResult'>;

// Saved event context only. Never fill missing fields from the current HTTP read,
// authenticated viewer, payload blobs, or import-history lookups.
const text = (value: unknown, limit: number) => typeof value === 'string'
  && value === value.trim() && value.length > 0 && value.length <= limit
  && !/[\u0000-\u001f\u007f]/.test(value)
  && !/(?:https?:\/\/|\/teams\/actions\/|bearer\s)/i.test(value) ? value : undefined;
const reference = (value: unknown) => {
  const result = text(value, 128);
  return result && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result) ? result : undefined;
};

export const readAuditProvenance = (log: AuditProvenance): AuditProvenance => ({
  source: text(log.source, 128), activeRole: text(log.activeRole, 128),
  correlationId: reference(log.correlationId), operationId: reference(log.operationId),
  importBatchId: reference(log.importBatchId), sourceIdentifier: text(log.sourceIdentifier, 256),
  importProcessingResult: text(log.importProcessingResult, 128),
});

export const AuditProvenanceDetails = ({provenance}: {provenance: AuditProvenance}) => {
  const saved = readAuditProvenance(provenance);
  const entries = [
    ['Recorded source', saved.source], ['Recorded active role', saved.activeRole],
    ['Saved correlation reference', saved.correlationId], ['Saved operation reference', saved.operationId],
    ['Import batch reference', saved.importBatchId], ['Source identifier', saved.sourceIdentifier],
    ['Recorded processing result', saved.importProcessingResult],
  ];
  return <section aria-label="Recorded audit provenance" className="min-w-0">
    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Recorded provenance</h4>
    <p className="text-xs text-body/60 mb-4">Saved event context. Missing or redacted values are not inferred. Source identifiers are diagnostic references, not proof of identity.</p>
    <dl className="space-y-3 text-xs break-words [overflow-wrap:anywhere] select-text">
      {entries.map(([label, value]) => <div key={label}>
        <dt className="font-medium text-body/60">{label}</dt>
        <dd className="font-bold text-heading">{value ?? 'Not recorded or unavailable'}</dd>
      </div>)}
    </dl>
  </section>;
};
