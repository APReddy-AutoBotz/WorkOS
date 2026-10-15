import {createHash} from 'node:crypto';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const canonicalizeJson = value => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
};

export const normalizeIdempotencyKey = value => (
  typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null
);

export const stableJsonStringify = value => JSON.stringify(canonicalizeJson(value));

export const hashImportRequest = value => createHash('sha256')
  .update(stableJsonStringify(value))
  .digest('hex');

export const createScopedIdempotencyLockKey = ({
  organizationId,
  legalEntityId,
  actorId,
  channel,
  idempotencyKey,
}) => stableJsonStringify([
  organizationId,
  legalEntityId,
  actorId,
  channel,
  idempotencyKey,
]);

export const createScopedEntityLockKey = ({organizationId, entityType, entityKey}) => stableJsonStringify([
  organizationId,
  entityType,
  entityKey,
]);

export const createProjectCodeLockKey = ({organizationId, projectCode}) => createScopedEntityLockKey({
  organizationId,
  entityType: 'ProjectCode',
  entityKey: String(projectCode).trim().toLowerCase(),
});
