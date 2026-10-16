const STATUS_CODES = new Map([
  [400, 'BAD_REQUEST'],
  [401, 'AUTHENTICATION_REQUIRED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [410, 'GONE'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [422, 'VALIDATION_FAILED'],
  [429, 'RATE_LIMITED'],
  [500, 'INTERNAL_ERROR'],
  [503, 'SERVICE_UNAVAILABLE'],
]);
const STABLE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const stableStatusCode = (status) => STATUS_CODES.get(status) || 'HTTP_ERROR';

const stableCode = (value, status) => typeof value === 'string' && STABLE_CODE.test(value)
  ? value
  : stableStatusCode(status);

const safeMessage = (body, status) => {
  if (status >= 500) return 'The request could not be completed.';
  const source = body?.error && typeof body.error === 'object' ? body.error : body;
  if (typeof source?.message === 'string' && source.message.trim()) return source.message.trim();
  if (typeof body?.error === 'string' && body.error.trim()) return body.error.trim();
  if (typeof body?.message === 'string' && body.message.trim()) return body.message.trim();
  return 'The request could not be completed.';
};

const errorEnvelope = (req, status, body) => {
  const source = body?.error && typeof body.error === 'object' ? body.error : body;
  const code = stableCode(source?.code || body?.code, status);
  const error = {
    code,
    message: safeMessage(body, status),
    correlationId: req.correlationId,
  };
  if (req.operationId) error.operationId = req.operationId;
  return {error};
};

/** Normalize legacy handler errors only when those handlers are served via /api/v1. */
export const versionedApiResponseContract = (req, res, next) => {
  req.apiVersion = 'v1';
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) return sendJson(errorEnvelope(req, res.statusCode, body));
    return sendJson(body);
  };
  next();
};

export const versionedApiErrorHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const candidate = Number(error?.statusCode || error?.status);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const parserFailure = error?.type === 'entity.parse.failed';
  const payloadTooLarge = error?.type === 'entity.too.large';
  return res.status(status).json({
    error: {
      code: parserFailure ? 'INVALID_REQUEST_BODY' : stableCode(error?.code, status),
      message: status >= 500
        ? 'The request could not be completed.'
        : parserFailure
          ? 'Request body must be valid JSON.'
          : payloadTooLarge ? 'Request body exceeds the allowed size.' : String(error?.message || 'The request could not be completed.'),
      correlationId: req.correlationId,
      ...(req.operationId ? {operationId: req.operationId} : {}),
    },
  });
};

export const normalizeVersionedError = errorEnvelope;
