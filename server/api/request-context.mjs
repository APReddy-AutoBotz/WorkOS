import {randomUUID} from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value.trim())
  ? value.trim()
  : null;

/**
 * Attach non-authoritative tracing identifiers to API requests.
 * Correlation IDs may be supplied by a caller after strict validation;
 * operation IDs are generated per state-changing HTTP request.
 */
export const createRequestContextMiddleware = ({idFactory = randomUUID} = {}) => (req, res, next) => {
  const correlationId = validId(req.get?.('X-Correlation-ID')) || idFactory();
  const operationId = SAFE_METHODS.has(String(req.method || 'GET').toUpperCase()) ? null : idFactory();

  req.correlationId = correlationId;
  if (operationId) req.operationId = operationId;
  else delete req.operationId;

  res.setHeader('X-Correlation-ID', correlationId);
  if (operationId) res.setHeader('X-Operation-ID', operationId);
  next();
};

export const isValidRequestContextId = validId;
