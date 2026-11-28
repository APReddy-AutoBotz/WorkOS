import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {commercialFixture} from './commercial-drafting-test.mjs';
import {startFixtureServer} from './compiled-fixture-server.mjs';

export async function verifyProjectCostJourney({baseUrl,tokenFor,identities,grants,engagement,project,today}) {
  const fixture = await startFixtureServer({root:fileURLToPath(new URL('../../',import.meta.url)),fixtures:['commercial-drafting'],apiUrl:baseUrl});
  let browser;
  try {
    const {chromium} = await import(process.env.WORKOS_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({headless:true,...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath:process.env.WORKOS_CHROMIUM_PATH} : {})});
    async function openForecast(identity) {
      const page = await browser.newPage();
      const {organizationId,legalEntityId} = commercialFixture;
      const permissions = [...grants,'employees.view','reports.view_utilization','commercial.contracts.view','commercial.project_costs.prepare','commercial.project_costs.decide'];
      await page.addInitScript(({session,scope,token}) => {
        sessionStorage.setItem('workos_session',JSON.stringify(session));
        sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
        sessionStorage.setItem('workos_api_token',token);
      },{session:{id:identity.id,userName:identity.username,name:'Synthetic finance user',role:identity.role,permissionRole:identity.role,permissions},scope:{organizationId,legalEntityId},token:tokenFor(identity)});
      await page.goto(fixture.url+'/tests/fixtures/commercial-drafting.html?live=1');
      const effort = page.getByRole('listitem').filter({has:page.getByRole('heading',{name:new RegExp(engagement.code)})}).getByRole('region',{name:'Fixed-fee approved effort'});
      await effort.getByLabel('Effort month').fill(today.slice(0,7));
      await effort.getByRole('button',{name:'Inspect approved effort'}).click();
      await effort.getByLabel('Include work through').fill(today);
      await effort.getByRole('button',{name:'Check allocation risk'}).click();
      const forecast = effort.getByRole('region',{name:'Fixed-fee completion forecast'});
      await forecast.getByRole('button',{name:'Inspect completion forecast'}).click();
      await forecast.getByRole('button',{name:'Inspect cost entries for '+today}).click();
      return forecast;
    }
    const reference = 'SYN-JOURNEY-EXPENSE';
    const preparer = await openForecast(identities.requester);
    await preparer.getByLabel('Cost project').selectOption(project.id);
    await preparer.getByLabel('Cost reference').fill(reference);
    await preparer.getByLabel('Incurred amount (GBP)').fill('0.0004');
    await preparer.getByRole('button',{name:'Submit cost for finance approval'}).click();
    const ownEntry = preparer.getByRole('listitem').filter({hasText:reference});
    await ownEntry.filter({hasText:'Pending approval'}).waitFor();
    assert.equal(await ownEntry.getByRole('button').count(),0);

    const reviewer = await openForecast(identities.second);
    await reviewer.getByText(/^Finance-approved non-labor cost.*GBP 12\.3456 \(1 approved\).*GBP -80\.9196/).waitFor();
    await reviewer.getByLabel('Decision reason').fill('Synthetic independent cost review');
    await reviewer.getByRole('button',{name:'Approve '+reference,exact:true}).click();
    await reviewer.getByText(/^Finance-approved non-labor cost.*GBP 12\.346 \(2 approved\).*GBP -80\.92 /).waitFor();
    await reviewer.getByText(/retained GBP 12\.3456 in approved non-labor costs.*GBP -80\.9196/).waitFor();

    await reviewer.getByLabel('Remaining forecast hours').fill('6.25');
    await reviewer.getByLabel('Remaining labor cost (GBP)').fill('30.1725');
    await reviewer.getByLabel('Expected total revenue at completion (GBP, optional)').fill('130.1234');
    await reviewer.getByLabel('Forecast assumptions').fill('Reviewed approved project costs');
    await reviewer.getByRole('button',{name:'Record completion forecast'}).click();
    await reviewer.getByText(/retained GBP 12\.346 in approved non-labor costs.*GBP -80\.92 /).waitFor();
  } finally {
    try {await browser?.close();} finally {await fixture.close();}
  }
}
