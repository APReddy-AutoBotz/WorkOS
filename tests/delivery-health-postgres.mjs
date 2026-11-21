import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readDeliveryHealth} from '../server/delivery-health.mjs';
import {withCommercialDatabase, migrateCommercialDatabase} from './support/commercial-drafting-test.mjs';

function cli(databaseUrl) {
  return spawnSync(process.execPath, ['server/delivery-health.mjs'], {
    encoding: 'utf8', timeout: 15000,
    env: {...process.env, NODE_ENV: 'test', APP_MODE: 'test', DATABASE_URL: databaseUrl, PGSSLMODE: 'disable'},
  });
}

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  const missingSchema = cli(databaseUrl);
  assert.equal(missingSchema.status, 1);
  assert.equal(missingSchema.stdout, '');
  assert.deepEqual(JSON.parse(missingSchema.stderr), {error: 'DELIVERY_HEALTH_UNAVAILABLE'});
  await migrateCommercialDatabase(pool);
  const sample = cli(databaseUrl);
  assert.equal(sample.status, 0, sample.stderr);
  const {sampledAt, ...signals} = JSON.parse(sample.stdout);
  assert.ok(Number.isFinite(Date.parse(sampledAt)));
  assert.deepEqual(signals, {pendingInvoiceAlerts: 0, oldestPendingSeconds: null, integrationFailures15m: 0,
    notificationFailures15m: 0, invoiceNoticeProducerFailures15m: 0, invoiceNoticePersistenceFailures15m: 0});

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into integration_event_logs(provider,event_type,status,created_at)
      select 'synthetic','health-test',status,now()+offset_seconds*interval '1 second'
      from (values ('Failed',-30),('Failed',-1000),('Failed',3600),('Success',-30),('Pending',-30)) v(status,offset_seconds)`);
    await client.query(`with notice as (
      insert into notification_events(event_type,title,body) values ('synthetic','Sample','Private detail') returning id
    ) insert into notification_delivery_attempts(notification_id,channel,status,attempted_at)
      select id,'InApp',status,now()+offset_seconds*interval '1 second' from notice cross join
      (values ('Failed',-30),('Failed',-60),('Failed',-1000),('Failed',3600),('Delivered',-30)) v(status,offset_seconds)`);
    const role = 'health_reader_' + randomBytes(8).toString('hex');
    await client.query('create role ' + role);
    for (const source of ['(status,created_at) on public.integration_event_logs',
      '(status,attempted_at) on public.notification_delivery_attempts',
      '(status,created_at) on public.invoice_export_alert_outbox',
      '(created_at) on public.invoice_export_notice_producer_failures',
      '(created_at) on public.invoice_export_notice_failures']) {
      await client.query('grant select ' + source + ' to ' + role);
    }
    await client.query('set local role ' + role);
    const health = await readDeliveryHealth(client);
    assert.equal(health.integrationFailures15m, 1);
    assert.equal(health.notificationFailures15m, 2);
    await assert.rejects(client.query('select request_payload from public.integration_event_logs'), {code: '42501'});
  } finally {
    await client.query('rollback');
    client.release();
  }
});
console.log('Delivery monitoring passed empty, rolling-window, restricted-reader and unavailable-schema checks.');
