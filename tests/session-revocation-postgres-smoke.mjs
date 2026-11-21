import assert from 'node:assert/strict';
import {randomBytes, scryptSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {readdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runMigrations} from '../server/migrate.mjs';
import {signJourneySession} from './support/import-audit-journey.mjs';
import {sessionHash} from '../server/modules/identity-access/session-lifecycle.mjs';
import {withCommercialDatabase, migrateCommercialDatabase, seedCommercialIdentities, withCommercialApi, withPreCommercialMigrations, commercialServerDir} from './support/commercial-drafting-test.mjs';

const claims = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const password = randomBytes(24).toString('base64url') + '-Synthetic!92';
const secret = randomBytes(48).toString('base64url');
await withCommercialDatabase(async ({pool, databaseUrl}) => {
  await withPreCommercialMigrations(async rootDir => {
    for (const file of await readdir(join(commercialServerDir,'migrations'))) {
      if (file >= '040_' && file <= '057_wos04_assignment_versions.sql') await copyFile(join(commercialServerDir,'migrations',file),join(rootDir,'migrations',file));
    }
    await runMigrations({pool,rootDir,logger:{log(){}}});
  });
  const identities = await seedCommercialIdentities(pool);
  const salt = randomBytes(16).toString('hex');
  await pool.query('update users set password_hash=$1 where id=$2',
    [`scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`, identities.manager.id]);
  await pool.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='Employee'", [identities.manager.id]);
  let revokedToken;
  await withCommercialApi({databaseUrl, identities, sessionSecret: secret}, async ({request, tokenFor}) => {
    const preUpgrade = tokenFor();
    const beforeUpgrade = await request('/api/auth/me',{headers:{Authorization:`Bearer ${preUpgrade}`}});
    assert.equal(beforeUpgrade.status,503);
    assert.equal(beforeUpgrade.body.code,'SESSION_AUTHORITY_UNAVAILABLE');
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['057a_wos04_session_revocations','057b_wos05_leave_submitter_lookup','057c_wos04_shared_auth_throttle','058_wos04_assignment_overlap_policy','058a_wos04_assignment_overlap_serialization','059_wos04_work_category_context','060_wos04_actual_work_evidence','061_wos04_calendar_leave_intake','062_wos04_native_forecast_evidence','063_wos05_staged_work_approvals','064_wos04_work_period_notices','065_wos05_assignment_material_approvals','065a_wos06_rate_cost_candidates', '065b_wos06_candidate_owners', '065c_wos06_commercial_candidate_approvals', '065d_wos06_approved_rate_adoptions', '065e_wos06_governed_tm_valuation', '065f_wos06_tm_billing_eligibility', '065g_wos06_invoice_draft_occupancy', '065h_wos06_invoice_batch_approval', '065i_wos06_approved_invoice_csv', '065j_wos06_invoice_export_notifications', '065k_wos06_invoice_billing_confirmation', '065l_wos06_invoice_action_required', '065m_wos06_milestone_billing_eligibility', '065n_wos06_milestone_invoice_lineage', '065o_wos06_milestone_invoice_approval', '065p_wos06_milestone_invoice_export', '065q_wos06_milestone_invoice_cancel_notice', '065r_wos06_milestone_invoice_confirmation', '065s_wos06_tm_period_versions', '065t_wos06_tm_financial_period_lock', '065u_wos06_financial_period_reopen', '065v_wos06_billing_eligibility_period', '065w_wos06_exported_line_reversal_requests', '065x_wos06_reversal_review_policy', '065y_wos06_reversal_review_submission', '065z_wos06_reversal_review_decisions', '066_wos06_full_line_reversal_eligibility', '067_wos06_correction_batch_reservations', '068_wos06_correction_review_evidence', '069_wos06_correction_batch_approval', '070_wos06_credit_export_lineage', '071_wos06_credit_billing_confirmation', '072_wos04_worker_type_assignments', '073_wos06_tm_entry_value_cap', '074_wos06_tm_nonchargeable_phase', '075_wos06_amended_tm_terms', '076_wos06_purchase_order_release', '077_wos06_po_line_commitments', '078_wos06_milestone_po_commitments', '079_wos06_fixed_fee_schedule', '080_wos06_fixed_fee_eligibility', '081_wos06_fixed_fee_invoice_drafts', '082_wos06_invoice_review_identity', '082a_wos01_session_lifetime', '082b_wos01_account_session_revocation', '082c_wos08_timesheet_entry_lookup', '082d_wos06_retainer_period_terms', '082e_wos06_retainer_capacity_policy', '082f_wos06_retainer_overage_policy', '082g_wos06_retainer_rounding', '082h_wos06_retainer_period_statements', '082i_wos06_retainer_statement_reviews', '082j_wos06_retainer_eligibility', '082k_wos06_retainer_invoice_drafts']);
    assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${preUpgrade}`}})).status,200);
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
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
    const logout = await request('/api/auth/logout', {headers: {...retained.headers, Cookie: `workos_session=${switched.body.token}`}, method: 'POST', body: {sid: claims(independent).sid}});
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
    assert.equal(audit[0].active_role, 'Admin', 'same-family audit retains bearer role precedence over a cookie role variant');
    assert.equal(audit[0].source, 'Web');
    assert.deepEqual(audit[0].new_value, {revoked: true});
    await assert.rejects(pool.query('delete from session_revocations where session_hash=$1', [key]), error => error.code === '55000');

    await assert.rejects(pool.query('update session_revocations set active_role=$1 where session_hash=$2',['Employee',key]), error => error.code === '55000');
    const mixed = [await login(),await login(),await login()];
    assert.equal((await request('/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${mixed[0]}`,
      Cookie:`workos_session=${mixed[1]}; workos_session=${mixed[2]}`},body:{sid:claims(independent).sid}})).status,200);
    for (const token of mixed) assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${token}`}})).status,401,
      'different bearer, shared cookie and duplicate-path cookie families must all be revoked');
    assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${independent}`}})).status,200);
    for (const sid of ['',null,{},'short']) {
      const malformed = signJourneySession({...claims(independent),sid},secret);
      assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${malformed}`}})).status,401);
    }
    for (const headers of [{},{Authorization:'Bearer invalid'}, {Cookie:'workos_session=invalid'}]) {
      assert.equal((await request('/api/auth/logout',{method:'POST',authenticated:false,headers})).status,200);
    }
    await withCommercialApi({databaseUrl,identities,sessionSecret:secret},async({request:secondRequest})=>{
      assert.equal((await secondRequest('/api/auth/me',{headers:{Authorization:`Bearer ${first}`}})).status,401,
        'a second API instance must honor the same durable revocation');
    });
    const evidence = JSON.stringify((await pool.query('select * from session_revocations')).rows);
    assert.equal(evidence.includes(first),false);assert.equal(evidence.includes(claims(first).sid),false);

    // Two credentials minted by pre-upgrade refresh/switch cannot be grouped.
    // Both must require a fresh login before and after logout of either one.
    const oldClaims = {...claims(independent),sid:undefined};
    const legacy = signJourneySession(oldClaims,secret);
    const legacySibling = signJourneySession({...oldClaims,exp:oldClaims.exp+1000,activeRole:'Employee'},secret);
    for (const token of [legacy,legacySibling,`${legacy}.extra`]) {
      for (const path of ['/api/auth/me','/api/v1/auth/me','/api/auth/organization-scopes','/api/employees'])
        assert.equal((await request(path,{headers:{Authorization:`Bearer ${token}`}})).status,401);
    }
    assert.equal((await request('/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${legacySibling}`}})).status,200);
    assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${legacy}`}})).status,401);

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
    assert.equal((await request('/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${preUpgrade}`}})).status,200);
    assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${preUpgrade}`}})).status,401);
    const oldSession = await login();
    const legacyFamily = tokenFor();
    const otherAccount = tokenFor(identities.reader);
    const bearer = token => ({headers: {Authorization: `Bearer ${token}`}});
    const sibling = await request('/api/auth/switch-role', {...bearer(oldSession), method: 'POST', body: {role: 'Employee'}});
    assert.equal(sibling.status, 200);
    const target = identities.manager.id;
    const revoke = 'select public.revoke_account_sessions($1, 0, $2)';
    const operator = 'test_responder_' + randomBytes(8).toString('hex');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`create role ${operator}`);
      await client.query(`set local role ${operator}`);
      await client.query('savepoint denied');
      await assert.rejects(client.query(revoke, [target, 'synthetic-incident']), {code: '42501'});
      await client.query('rollback to denied');
      await client.query('reset role');
      await client.query(`grant execute on function public.revoke_account_sessions(uuid,integer,text) to ${operator}`);
      await client.query(`alter table audit_logs add constraint test_reject_session_audit check (action <> 'RevokeAccountSessions') not valid`);
      await client.query('savepoint failed_audit');
      await assert.rejects(client.query(revoke, [target, 'synthetic-failure']), {code: '23514'});
      await client.query('rollback to failed_audit');
      await client.query('alter table audit_logs drop constraint test_reject_session_audit');
      await client.query(`set local role ${operator}`);
      await client.query(revoke, [target, 'synthetic-incident']);
      await client.query('reset role');
      await client.query(`revoke execute on function public.revoke_account_sessions(uuid,integer,text) from ${operator}`);
      await client.query(`drop role ${operator}`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    await assert.rejects(pool.query(revoke, [target, 'synthetic-retry']), /generation did not match/);
    const evidenceRows = (await pool.query(`select user_id=session_user as authenticated,active_role,old_value,new_value,reason
      from audit_logs where action='RevokeAccountSessions' and entity_id=$1`, [target])).rows;
    assert.deepEqual(evidenceRows, [{authenticated:true, active_role:operator, old_value:{generation:0},
      new_value:{generation:1}, reason:'synthetic-incident'}]);
    await pool.query("update users set status='Inactive' where id=$1", [target]);
    await pool.query("update users set status='Active' where id=$1", [target]);
    for (const token of [oldSession, sibling.body.token, legacyFamily]) {
      assert.equal((await request('/api/auth/me', bearer(token))).status, 401);
    }
    assert.equal((await request('/api/auth/me', bearer(otherAccount))).status, 200);
    const fresh = await login();
    assert.equal(claims(fresh).sessionGeneration, 1);
    const refreshed = await request('/api/auth/me', bearer(fresh));
    assert.equal(refreshed.status, 200);
    assert.equal(claims(refreshed.body.token).sessionGeneration, 1);
    await pool.query("select public.revoke_account_sessions($1,1,'synthetic-followup')", [target]);
    assert.equal((await request('/api/auth/me', bearer(refreshed.body.token))).status, 401);
    revokedToken = oldSession;
  });
  await withCommercialApi({databaseUrl, identities, sessionSecret: secret}, async ({request}) => {
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${revokedToken}`}})).status, 401,
      'revocation must survive API restart');
  });
  await withCommercialApi({databaseUrl, identities, sessionTtlHours: '0.0003'}, async ({request}) => {
    const started = Date.now();
    const login = await request('/api/auth/login', {method: 'POST', authenticated: false,
      body: {username: identities.manager.username, password, requestedRole: 'Admin'}});
    assert.equal(login.status, 200);
    const expires = claims(login.body.token).exp;
    assert.ok(expires >= started + 1079 && expires <= Date.now() + 1080, 'token expiry must match the configured fractional lifetime');
    await delay(Math.max(0, expires - Date.now() + 60));
    assert.equal((await request('/api/auth/me', {headers: {Authorization: `Bearer ${login.body.token}`}})).status, 401);
  });
});
console.log('Session PostgreSQL/API acceptance passed: absolute expiry, role/refresh family, bearer/cookie replay denial, idempotent audited logout, independent sessions, legacy reauthentication, restart persistence, immutable evidence and storage/audit failure.');
