import 'dotenv/config';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {validateRuntimeEnvironment} from './environment.mjs';
import {databaseConnectionOptions} from './database-connection.mjs';

// One statement gives every gauge the same MVCC snapshot and window boundary.
export async function readDeliveryHealth(db) {
  const {rows} = await db.query(`
    with bounds as (select statement_timestamp() as sampled, statement_timestamp() - interval '15 minutes' as since)
    select json_build_object(
      'sampledAt', sampled,
      'pendingInvoiceAlerts', count(q.status),
      'oldestPendingSeconds', case when min(q.created_at) is not null then
        greatest(0, floor(extract(epoch from sampled - min(q.created_at)))) end,
      'integrationFailures15m', (select count(status) from public.integration_event_logs
        where status = 'Failed' and created_at between since and sampled),
      'notificationFailures15m', (select count(status) from public.notification_delivery_attempts
        where status = 'Failed' and attempted_at between since and sampled),
      'invoiceNoticeProducerFailures15m', (select count(created_at) from public.invoice_export_notice_producer_failures
        where created_at between since and sampled),
      'invoiceNoticePersistenceFailures15m', (select count(created_at) from public.invoice_export_notice_failures
        where created_at between since and sampled)
    ) as health from bounds left join public.invoice_export_alert_outbox q on q.status = 'Pending'
    group by sampled, since`);
  return rows[0].health;
}

async function sample() {
  const env = validateRuntimeEnvironment(process.env, {purpose: 'migration'});
  const client = new pg.Client({
    ...databaseConnectionOptions({databaseUrl: env.databaseUrl, sslMode: env.pgSslMode, sslRootCert: env.pgSslRootCert}),
    connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7000,
  });
  try {
    await client.connect();
    await client.query('begin read only');
    const health = await readDeliveryHealth(client);
    await client.query('commit');
    return health;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await sample()));
  } catch {
    console.error(JSON.stringify({error: 'DELIVERY_HEALTH_UNAVAILABLE'}));
    process.exitCode = 1;
  }
}
