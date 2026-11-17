import assert from 'node:assert/strict';
import {randomBytes, scryptSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './support/compiled-fixture-server.mjs';
import {chromium} from 'playwright';
import {withCommercialDatabase,migrateCommercialDatabase,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await withCommercialDatabase(async ({pool,databaseUrl}) => {
  await migrateCommercialDatabase(pool);
  const identities = await seedCommercialIdentities(pool);
  const password = randomBytes(24).toString('base64url') + '-Synthetic!92', salt = randomBytes(16).toString('hex');
  await pool.query('update users set password_hash=$1,must_change_password=false where id=$2',
    [`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`, identities.manager.id]);
  await withCommercialApi({databaseUrl,identities}, async ({baseUrl:apiUrl,request}) => {
    const fixtureServer = await startFixtureServer({root, application: true, apiUrl, modules: {authService: 'src/services/authService.ts'}});
    let browser;
    try {
      browser = await chromium.launch({headless:true});
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      const origin = fixtureServer.url;
      // Load the compiled login page separately from interaction
      // deadlines; this fixture is a workflow check, not a cold-start benchmark.
      const warmPage = await browser.newPage();
      try {
        await warmPage.goto(`${origin}/login`,{timeout:60000});
        await warmPage.getByRole('button',{name:'Open Workspace',exact:true}).waitFor({timeout:60000});
      } finally { await warmPage.close(); }
      console.log('Compiled login page ready; interaction deadlines unchanged.');
      const login = async () => {
        await page.goto(`${origin}/login`);
        await page.getByLabel('Username',{exact:true}).fill(identities.manager.username);
        await page.getByLabel('Password',{exact:true}).fill(password);
        await page.getByRole('button',{name:'Open Workspace',exact:true}).click();
        await page.getByTitle('Logout',{exact:true}).first().waitFor();
        return page.evaluate(() => sessionStorage.getItem('workos_api_token'));
      };
      const first = await login();
      assert.ok(first);
      let releaseLogout, observeLogout;
      const logoutHeld = new Promise(resolve => {releaseLogout = resolve;});
      const logoutObserved = new Promise(resolve => {observeLogout = resolve;});
      await page.route('**/api/auth/logout', async route => {
        observeLogout();
        await logoutHeld;
        await route.continue();
      });
      // Clearing device authority can make a route guard navigate before the
      // server transaction finishes. Observe its acknowledgement before replay.
      const logoutResponse = page.waitForResponse(response => response.url() === `${origin}/api/auth/logout`
        && response.request().method() === 'POST');
      await page.getByTitle('Logout',{exact:true}).first().click();
      await logoutObserved;
      assert.equal(await page.evaluate(() => sessionStorage.getItem('workos_api_token')),null,
        'device credentials clear before server acknowledgement');
      assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${first}`}})).status,200,
        'a withheld logout request has not revoked the server session');
      releaseLogout();
      const acknowledgedLogout = await logoutResponse;
      assert.equal(acknowledgedLogout.status(),200);
      assert.equal((await acknowledgedLogout.json()).status,'ok');
      await page.waitForURL(`${origin}/login`);
      assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${first}`}})).status,401);
      assert.deepEqual(await page.evaluate(() => ['workos_api_token','workos_organization_scope','workos_session'].map(k=>sessionStorage.getItem(k))),[null,null,null]);
      assert.equal((await pool.query("select count(*)::int n from audit_logs where action='Logout'")).rows[0].n,1);
      await page.unroute('**/api/auth/logout');

      const second = await login();
      let releaseRefresh, observedRefresh;
      const heldRefresh = new Promise(resolve => {releaseRefresh = resolve;});
      const refreshObserved = new Promise(resolve => {observedRefresh = resolve;});
      await page.route('**/api/auth/me', async route => {
        const response = await route.fetch();
        observedRefresh();
        await heldRefresh;
        await route.fulfill({response});
      });
      await page.evaluate(() => {window.syntheticPendingRefresh = import('/tests/fixtures/authService.js').then(({authService}) => authService.refreshSession());});
      await refreshObserved;
      await page.route('**/api/auth/logout',route=>route.abort('connectionfailed'));
      await page.getByTitle('Logout',{exact:true}).first().click();
      await page.waitForURL(`${origin}/login?logout=unconfirmed`);
      await page.getByText('Signed out on this device',{exact:true}).waitFor();
      await page.getByText('Server sign-out could not be confirmed. Your server session may remain active until it expires.',{exact:true}).waitFor();
      releaseRefresh();
      assert.equal(await page.evaluate(() => window.syntheticPendingRefresh), null, 'late refresh must not restore a signed-out session');
      assert.deepEqual(await page.evaluate(() => ['workos_api_token','workos_organization_scope','workos_session'].map(k=>sessionStorage.getItem(k))),[null,null,null]);
      assert.equal((await request('/api/auth/me',{headers:{Authorization:`Bearer ${second}`}})).status,200,
        'failed delivery must not be misrepresented as server revocation');
      console.log('Actual login/sidebar logout browser journey passed: persisted server revocation, cleared device credentials/scope, late refresh rejection, failed-delivery warning and honest server status.');
    } finally {await browser?.close();await fixtureServer.close();}
  });
});
