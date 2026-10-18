import pg from 'pg';

const allowedHosts = new Set(['localhost', '127.0.0.1', 'postgres', '::1']);
const hostName = value => String(value).toLowerCase().replace(/^\[|\]$/g, '');
const invalid = () => new Error('A complete, query-free local PostgreSQL fixture URL is required.');

// Validate the actual driver's target before any socket, migration or cleanup.
// Do not retain parse errors: URL/pg errors may include credential-bearing input.
export const readDisposablePostgresTarget = raw => {
  try {
    if (typeof raw !== 'string' || !raw) throw invalid();
    const target = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(target.protocol)
        || !allowedHosts.has(hostName(target.hostname)) || target.search || target.hash
        || !target.username || !target.pathname.slice(1)) throw invalid();
    for (const part of [target.username, target.password, target.pathname]) decodeURIComponent(part);
    if (!target.port) target.port = '5432';
    const effective = new pg.Client({connectionString: target.toString()}).connectionParameters;
    if (!allowedHosts.has(hostName(effective.host)) || hostName(effective.host) !== hostName(target.hostname)
        || effective.port !== Number(target.port)) throw invalid();
    return target;
  } catch {
    throw invalid();
  }
};
