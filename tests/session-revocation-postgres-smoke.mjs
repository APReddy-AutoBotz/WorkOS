import assert from 'node:assert/strict';
import {randomBytes, scryptSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {sessionHash} from '../server/modules/identity-access/session-lifecycle.mjs';
import {withCommercialDatabase, migrateCommercialDatabase, seedCommercialIdentities, withCommercialApi} from './support/commercial-drafting-test.mjs';

const claims = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const password = randomBytes(24).toString('base64url') + '-Synthetic!92';
const secret = randomBytes(48).toString('base64url');
await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const identities = await seedCommercialIdentities(pool);
  const salt = randomBytes(16).toString('hex');
  await pool.query('update users set password_hash=$1 where id=$2',
    [`scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`, identities.manager.id]);
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Employee'", [identities.manager.id]);
  let revokedToken;
  await withCommercialApi({databaseUrl, identities, sessionSecret: secret}, async ({request, tokenFor}) => {
    const login = async () => {
      const response = await request('/api/auth/login', {method: 'POST', authenticated: false,
        body: {username: identities.manager.username, password, requestedRole: 'Admin'}});
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.match(claims(response.body.token).sid, /^[a-f0-9-]{36}$/);
      return response.body.token;
    };
    const first = await login(), independent = await login();
    assert.notEqual(claims(first).sid, claims(independent).sid);
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${first}.extra`}})).status, 401,
      'a signed prefix must not authorize a malformed token with extra segments');
    const retained = {headers: {Authorization: `Bearer ${first}`}};
    const refresh = await request('/api/auth/me', retained);
    const switched = await request('/api/auth/switch-role', {...retained, method: 'POST', body: {role: 'Employee'}});
    for (const response of [refresh, switched]) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(claims(response.body.token).sid, claims(first).sid);
      assert.equal(claims(response.body.token).exp, claims(first).exp, 'refresh/switch cannot extend the absolute expiry');
      const maxAge = Number(response.response.headers.get('set-cookie').match(/Max-Age=(\d+)/)?.[1]);
      assert.ok(maxAge > 0 && maxAge <= 900, 'cookie must carry remaining configured lifetime');
    }
    const logout = await request('/api/auth/logout', {...retained, method: 'POST', body: {sid: claims(independent).sid}});
    assert.equal(logout.status, 200);
    assert.match(logout.response.headers.get('set-cookie'), /workos_session=;/);
    for (const token of [first, refresh.body.token, switched.body.token]) {
      for (const path of ['/api/auth/me', '/api/v1/auth/me', '/api/auth/organization-scopes', '/api/employees']) {
        assert.equal((await request(path, {headers: {Authorization: `Bearer ${token}`}})).status, 401, path);
      }
    }
    assert.equal((await request('/api/auth/me', {authenticated: false, headers: {Cookie: `workos_session=${first}`}})).status, 401);
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${independent}`}})).status, 200);
    assert.equal((await request('/api/auth/logout', {...retained, method: 'POST'})).status, 200);
    const key = sessionHash(claims(first).sid);
    assert.equal((await pool.query('select count(*)::int n from session_revocations where session_hash=$1', [key])).rows[0].n, 1);
    const audit = (await pool.query("select user_id,active_role,source,old_value,new_value from audit_logs where action='Logout' and entity_id=$1", [key])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].user_id, identities.manager.id);
    assert.equal(audit[0].active_role, 'Admin');
    assert.equal(audit[0].source, 'Web');
    assert.deepEqual(audit[0].new_value, {revoked: true});
    await assert.rejects(pool.query('delete from session_revocations where session_hash=$1', [key]), error => error.code === '55000');

    const legacy = tokenFor();
    const legacyRefresh = await request('/api/auth/me', {headers: {Authorization: `Bearer ${legacy}`}});
    assert.equal(legacyRefresh.status, 200);
    assert.equal((await request('/api/auth/logout', {method: 'POST', headers: {Authorization: `Bearer ${legacyRefresh.body.token}`}})).status, 200);
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${legacy}`}})).status, 401,
      'pre-upgrade token and its new refresh must share revocation');
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${legacy}.extra`}})).status, 401,
      'extra token segments must not create an unrevoked legacy family');

    await pool.query('alter table session_revocations rename to session_revocations_offline');
    const other = {headers: {Authorization: `Bearer ${independent}`}};
    assert.equal((await request('/api/auth/me', other)).status, 503);
    const unavailable = await request('/api/auth/logout', {...other, method: 'POST'});
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'SESSION_REVOCATION_UNCONFIRMED');
    await pool.query('alter table session_revocations_offline rename to session_revocations');
    assert.equal((await request('/api/auth/me', other)).status, 200);

    await pool.query("create function synthetic_logout_audit_failure() returns trigger language plpgsql as $$ begin if new.action='Logout' then raise exception 'synthetic refusal'; end if; return new; end $$; create trigger synthetic_logout_audit_failure before insert on audit_logs for each row execute function synthetic_logout_audit_failure()");
    assert.equal((await request('/api/auth/logout', {...other, method: 'POST'})).status, 503);
    assert.equal((await request('/api/auth/me', other)).status, 200, 'audit refusal must roll back revocation');
    await pool.query('drop trigger synthetic_logout_audit_failure on audit_logs; drop function synthetic_logout_audit_failure()');
    assert.equal((await request('/api/auth/logout', {...other, method: 'POST'})).status, 200);
    revokedToken = first;
  });
  await withCommercialApi({databaseUrl, identities, sessionSecret: secret}, async ({request}) => {
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${revokedToken}`}})).status, 401,
      'revocation must survive API restart');
  });
  await withCommercialApi({databaseUrl, identities, sessionTtlHours: '0.0003'}, async ({request}) => {
    const login = await request('/api/auth/login', {method: 'POST', authenticated: false,
      body: {username: identities.manager.username, password, requestedRole: 'Admin'}});
    assert.equal(login.status, 200);
    await delay(Math.max(0, claims(login.body.token).exp - Date.now() + 60));
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${login.body.token}`}})).status, 401);
  });
});
console.log('Session PostgreSQL/API acceptance passed: absolute expiry, role/refresh family, bearer/cookie replay denial, idempotent audited logout, independent sessions, legacy transition, restart persistence, immutable evidence and storage/audit failure.');
