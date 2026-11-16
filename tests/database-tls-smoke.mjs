import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createSecureContext, TLSSocket} from 'node:tls';
import pg from 'pg';
import {databaseConnectionOptions} from '../server/database-connection.mjs';

const directory = mkdtempSync(join(tmpdir(), 'workos-database-tls-'));
const certificate = name => {
  const cert = join(directory, `${name}.crt`), key = join(directory, `${name}.key`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=synthetic-database', '-addext', `subjectAltName=${name === 'trusted' ? 'IP:127.0.0.1,DNS:localhost' : 'DNS:wrong.example.test'}`,
    '-keyout', key, '-out', cert], {stdio: 'ignore', timeout: 10000});
  return {cert, secureContext: createSecureContext({cert: readFileSync(cert), key: readFileSync(key)})};
};
const withEndpoint = async (context, run) => {
  const sockets = new Set();
  let startupMessages = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.once('data', request => {
      assert.equal(request.readInt32BE(4), 80877103, 'actual pg client must request TLS');
      socket.write('S');
      const secure = new TLSSocket(socket, {isServer: true, secureContext: context});
      secure.on('error', () => {});
      secure.once('data', () => {
        startupMessages++;
        // Minimal synthetic PostgreSQL AuthenticationOk and ReadyForQuery.
        secure.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpointUrl = new URL('postgresql://127.0.0.1/synthetic');
  endpointUrl.port = String(server.address().port);
  try { await run(endpointUrl.toString(), () => startupMessages); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
};
const connect = async options => {
  const client = new pg.Client({...options, connectionTimeoutMillis: 3000});
  try { await client.connect(); } finally { await client.end().catch(() => {}); }
};
try {
  const trusted = certificate('trusted'), wrong = certificate('wrong');
  await withEndpoint(trusted.secureContext, async (databaseUrl, count) => {
    await assert.rejects(connect(databaseConnectionOptions({databaseUrl, sslMode: 'require'})), /self.signed|certificate/i);
    assert.equal(count(), 0, 'untrusted peer must not receive PostgreSQL startup data');
    for (const sslMode of ['require', 'verify-full']) {
      await connect(databaseConnectionOptions({databaseUrl, sslMode, sslRootCert: trusted.cert}));
    }
    assert.equal(count(), 2, 'trusted correctly named peer connects through the actual pg transport');
  });
  await withEndpoint(wrong.secureContext, async (databaseUrl, count) => {
    await assert.rejects(connect(databaseConnectionOptions({databaseUrl, sslMode: 'require', sslRootCert: wrong.cert})),
      error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(count(), 0, 'trusted but wrongly named peer must not receive startup data');
  });
  await withEndpoint(wrong.secureContext, async (databaseUrl, count) => {
    await assert.rejects(async () => connect(databaseConnectionOptions({databaseUrl: `${databaseUrl}?host=wrong.example.test&host=127.0.0.1`, sslMode: 'require', sslRootCert: wrong.cert})), /Duplicate DATABASE_URL host/);
    assert.equal(count(), 0, 'duplicate host cannot select different verification and connection targets');
  });
  const databaseUrl = 'postgresql://127.0.0.1/synthetic';
  assert.throws(() => databaseConnectionOptions({databaseUrl: `${databaseUrl}?host=synthetic%252Eexample.test`, sslMode: 'require'}), /unambiguous DNS/);
  const emptyCa = join(directory, 'empty.crt'); writeFileSync(emptyCa, '');
  assert.throws(() => databaseConnectionOptions({databaseUrl, sslMode: 'require', sslRootCert: emptyCa}), /trusted certificate bundle/);
  for (const query of ['sslmode=disable', 'ssl=no-verify', 'sslmode=require', 'sslrootcert=ignored', 'uselibpqcompat=true', '%73slmode=disable', 'sslmode=require&sslmode=disable', 'SSLMode=disable']) {
    assert.throws(() => databaseConnectionOptions({databaseUrl: `${databaseUrl}?${query}`, sslMode: 'require'}), /Configure database TLS/);
  }
  assert.throws(() => databaseConnectionOptions({databaseUrl, sslMode: 'require', sslRootCert: join(directory, 'missing')}), /could not be read/);
  assert.throws(() => databaseConnectionOptions({databaseUrl, sslMode: 'no-verify'}), /Invalid PGSSLMODE/);
  assert.throws(() => databaseConnectionOptions({databaseUrl, sslMode: 'disable', sslRootCert: trusted.cert}), /requires verified/);
  assert.equal(databaseConnectionOptions({databaseUrl, sslMode: 'disable'}).ssl, false);
  assert.equal(databaseConnectionOptions().ssl, false, 'unconfigured development remains compatible');
  console.log('Database TLS passed: actual pg trusted handshake, untrusted/wrong-host rejection before startup, URL downgrade denial, missing CA and explicit local plaintext. Synthetic protocol fixture, not a production database.');
} finally { rmSync(directory, {recursive: true, force: true}); }
