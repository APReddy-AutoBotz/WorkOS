import {randomBytes} from 'node:crypto';

// Ephemeral values never authenticate to external services or survive a test run.
export const syntheticCredential = () => randomBytes(32).toString('base64url');
export const syntheticHexDigest = () => randomBytes(32).toString('hex');
// Keep explicit invalid-value coverage separate from usable test credentials.
export const rejectedConfigurationValues = Object.freeze({short: 'short', placeholder: 'replace_me'});
export const syntheticDatabaseUrl = (host, database, value = syntheticCredential()) => {
  const url = new URL(`postgresql://${host}/${database}`);
  url.username = 'workos';
  url.password = value;
  return url.toString();
};
