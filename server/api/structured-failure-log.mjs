import {stableStatusCode} from './v1/error-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_METHOD = /^[A-Z]{1,12}$/;

const defaultWrite = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error') console.error(line);
  else console.warn(line);
};

const safeId = (value) => typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;

/**
 * Create a structured, payload-free API failure logger. Only the server-owned
 * matched route template is used as the operation name; raw request URLs are
 * deliberately unavailable to this module.
 */
export const createStructuredApiFailureLogger = ({write = defaultWrite, now = () => new Date()} = {}) => (req, res) => {
  const status = Number(res.statusCode);
  if (!Number.isInteger(status) || status < 400) return;

  const method = String(req.method || '').toUpperCase();
  const safeMethodName = SAFE_METHOD.test(method) ? method : 'UNKNOWN';
  const route = req.route?.path;
  const routeTemplate = typeof route === 'string' ? route : '<unknown>';
  const apiNamespace = req.apiVersion === 'v1' ? 'v1' : 'legacy';
  const record = {
    timestamp: now().toISOString(),
    level: status >= 500 ? 'error' : 'warn',
    service: 'api',
    operation: `${apiNamespace} ${safeMethodName} ${routeTemplate}`,
    status,
    code: stableStatusCode(status),
    correlationId: safeId(req.correlationId) || 'unknown',
    ...(safeId(req.operationId) ? {operationId: safeId(req.operationId)} : {}),
  };

  write(record);
};
