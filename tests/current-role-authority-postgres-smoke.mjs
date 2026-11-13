import assert from 'node:assert/strict';
import {withCommercialDatabase, migrateCommercialDatabase, seedCommercialIdentities, withCommercialApi} from './support/commercial-drafting-test.mjs';

await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const identities = await seedCommercialIdentities(pool);
  await withCommercialApi({databaseUrl, identities, apiRoot: process.env.WORKOS_TEST_API_ROOT}, async ({request, tokenFor}) => {
    const token = tokenFor(identities.manager);
    const retained = {headers: {Authorization: `Bearer ${token}`}};
    assert.equal((await request('/api/permissions/config', retained)).status, 200);
    await pool.query(`insert into user_roles(user_id,role_id) select $1,id from roles where name='Employee' on conflict do nothing`, [identities.manager.id]);
    await pool.query(`delete from user_roles where user_id=$1 and role_id=(select id from roles where name='Admin')`, [identities.manager.id]);
    for (const path of ['/api/permissions/config', '/api/employees', '/api/v1/commercial-drafting/contracts',
      '/api/auth/me', '/api/v1/auth/me', '/api/auth/organization-scopes', '/api/v1/auth/organization-scopes']) {
      const result = await request(path, retained);
      assert.equal(result.status, 403, `${path} must reject the retained removed-role token`);
      assert.equal(path.startsWith('/api/v1/') ? result.body.error.code : result.body.code, 'SESSION_ROLE_REVOKED');
    }
    assert.equal((await request('/api/auth/switch-role', {...retained, method: 'POST', body: {role: 'Employee'}})).status, 403);
    const cookieOnly = await request('/api/auth/me', {authenticated: false, headers: {Cookie: `workos_session=${token}`}});
    assert.equal(cookieOnly.status, 403, 'Cookie and bearer identities must enforce the same current-role authority');
    assert.equal((await request('/api/auth/me', {identity: identities.manager, role: 'Employee'})).status, 200,
      'A newly authenticated, currently assigned role remains usable');
    assert.equal((await request('/api/auth/me', {identity: identities.reader, role: 'Admin'})).status, 403,
      'A signed but unassigned active role is not authority');
    await pool.query(`insert into entra_group_role_mappings(id,group_id,group_name,role_name,active)
      values ('synthetic-role-map','synthetic-verified-group','Synthetic group','Admin',true)`);
    const mappedToken = tokenFor(identities.reader, 'Admin', {identityProvider: 'entra', entraGroups: ['synthetic-verified-group']});
    const mapped = {headers: {Authorization: `Bearer ${mappedToken}`}};
    const refreshed = await request('/api/auth/me', mapped);
    assert.equal(refreshed.status, 200, 'Verified Entra group mappings remain supported');
    assert.equal(refreshed.body.activeRole, 'Admin');
    const refreshClaims = JSON.parse(Buffer.from(refreshed.body.token.split('.')[0], 'base64url').toString());
    assert.deepEqual(refreshClaims.entraGroups, ['synthetic-verified-group']);
    const switched = await request('/api/auth/switch-role', {...mapped, method: 'POST', body: {role: 'Employee'}});
    assert.equal(switched.status, 200);
    const switchBack = await request('/api/auth/switch-role', {method: 'POST', body: {role: 'Admin'}, headers: {Authorization: `Bearer ${switched.body.token}`}});
    assert.equal(switchBack.status, 200, 'Role switching retains verified provider context');
    const localGroups = tokenFor(identities.reader, 'Admin', {identityProvider: 'local', entraGroups: ['synthetic-verified-group']});
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${localGroups}`}})).status, 403);
    await pool.query(`update entra_group_role_mappings set active=false where id='synthetic-role-map'`);
    for (const retainedToken of [mappedToken, refreshed.body.token, switchBack.body.token]) {
      assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${retainedToken}`}})).status, 403,
        'Revoked mapping must deny original, refreshed and role-switched sessions');
    }
    await pool.query(`update users set status='Disabled' where id=$1`, [identities.reader.id]);
    assert.equal((await request('/api/v1/auth/me', {identity: identities.reader})).status, 403);
    assert.equal((await request('/api/permissions/config', {authenticated: false})).status, 401);
  });
});
console.log('Current-role PostgreSQL/API authority: retained bearer/cookie, removed/forged role, disabled account and identity-only/versioned/legacy routes passed.');
