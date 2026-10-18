import {ApiClientError} from '../../services/apiClient';

export type ImportFailureReferences = {correlationId?: string; operationId?: string};

// Response IDs use the server request-context format. Never coerce error values
// or retain messages, request payloads, credentials or retry keys here.
const safeReference = (value: unknown) => typeof value === 'string'
  && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;

export const readImportFailureReferences = (error: unknown): ImportFailureReferences | null => {
  if (!(error instanceof ApiClientError)) return null;
  const correlationId = safeReference(error.correlationId);
  const operationId = safeReference(error.operationId);
  return correlationId || operationId ? {correlationId, operationId} : null;
};

export const ImportFailureReferences = ({references}: {references: ImportFailureReferences | null}) => (
  references ? <div className="mt-3 text-xs">
    <p>Share these request references with support. A retry may have different references.</p>
    <dl aria-label="Request references for support" className="mt-2 space-y-1 break-all select-text">
      {references.correlationId && <div><dt className="font-bold">Correlation reference</dt><dd>{references.correlationId}</dd></div>}
      {references.operationId && <div><dt className="font-bold">Operation reference</dt><dd>{references.operationId}</dd></div>}
    </dl>
  </div> : null
);
