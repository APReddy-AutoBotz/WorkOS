import {readFileSync} from 'node:fs';
import {checkServerIdentity} from 'node:tls';

// Use the same verified transport policy for application and migration connections.
export const databaseConnectionOptions = ({databaseUrl, sslMode = 'disable', sslRootCert} = {}) => {
  if (!['disable', 'require', 'verify-full'].includes(sslMode)) throw new Error('Invalid PGSSLMODE.');
  let expectedHost;
  if (databaseUrl) {
    let url;
    try { url = new URL(databaseUrl); } catch { throw new Error('Invalid DATABASE_URL.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid DATABASE_URL protocol.');
    if (url.searchParams.getAll('host').length > 1) throw new Error('Duplicate DATABASE_URL host parameters are not allowed.');
    // Query values are already decoded by URLSearchParams, as in the locked pg parser.
    expectedHost = (url.searchParams.get('host') || decodeURIComponent(url.hostname)).replace(/^\[|\]$/g, '');
    // node-postgres URL parsing overrides the explicit ssl object. Reject alternate
    // transport controls instead of silently downgrading or discarding the trusted CA.
    if ([...url.searchParams.keys()].some(key => /^ssl/i.test(key) || key.toLowerCase() === 'uselibpqcompat')) {
      throw new Error('Configure database TLS with PGSSLMODE and PGSSLROOTCERT, not DATABASE_URL query parameters.');
    }
  }
  if (sslMode === 'disable') {
    if (sslRootCert) throw new Error('PGSSLROOTCERT requires verified database TLS.');
    return {connectionString: databaseUrl, ssl: false};
  }
  if (!expectedHost) throw new Error('Verified database TLS requires a DATABASE_URL hostname.');
  if (expectedHost.includes('%') || expectedHost.includes('/') || expectedHost.includes('\\')) {
    throw new Error('Verified database TLS requires an unambiguous DNS name or IP address.');
  }
  let ca;
  if (sslRootCert) {
    try { ca = readFileSync(sslRootCert, 'utf8'); } catch { throw new Error('PGSSLROOTCERT could not be read.'); }
    if (!ca.trim()) throw new Error('PGSSLROOTCERT must contain a trusted certificate bundle.');
  }
  return {connectionString: databaseUrl, ssl: {rejectUnauthorized: true,
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(expectedHost, certificate),
    ...(ca ? {ca} : {})}};
};
