import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const browser = await chromium.launch({headless:true,
  ...(process.env.WORKOS_CHROMIUM_PATH ? {executablePath:process.env.WORKOS_CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage();
  await page.goto((process.env.WORKOS_BROWSER_BASE_URL || 'http://127.0.0.1:4177') + '/tests/fixtures/planning-signals.html');
  const day = offset => new Date(Date.UTC(2028,1,28+offset)).toISOString().slice(0,10);
  const offsets = [46,45,44,42,40,30,20,10,5,2,1,0,-1,null];
  const rows = offsets.map((offset,index) => ({
    employeeId:String(index), employeeCode:'SYN-'+index, employeeName:'Synthetic resource '+index,
    department:'Planning', allocations:[], activeProjectCount:0, plannedUtilization:0,
    availabilityHours:index===0 ? null : index===1 ? 0 : 40, bench:true, underloaded:false, overloaded:false,
    rollOffDate:offset === null ? undefined : day(offset),
  }));
  await page.evaluate(report => window.showPlanningReport(report), {
    asOfDate:day(0),rows,summary:{people:14,averagePlanned:0,averageAvailabilityAdjustedCapacity:null,
      benchCount:14,overloadedCount:0,underloadedCount:0,rollOffSoonCount:11},
  });
  await page.getByText('Unavailable',{exact:true}).waitFor();
  await page.getByText('Annual hours unavailable',{exact:true}).waitFor();
  await page.getByText('0h available in 2028',{exact:true}).waitFor();
  await page.getByPlaceholder('Search resource').fill('unmatched search');
  await page.getByRole('button',{name:/Roll-offs in 45 days/}).click();
  const names = page.getByRole('link',{name:/^Synthetic resource /});
  const ordered = rows.slice(1,12).reverse().map(row => row.employeeName);
  await names.first().waitFor();
  assert.deepEqual(await names.allTextContents(),ordered.slice(0,10));
  await page.getByRole('button',{name:'Show more resources'}).click();
  assert.deepEqual(await names.allTextContents(),ordered);
  const highlights = page.getByRole('heading',{name:'Upcoming roll-offs'}).locator('../..').locator('..');
  assert.deepEqual(await highlights.locator('button p:first-child').allTextContents(),ordered.slice(0,8));
  console.log('Planning roll-off boundaries, report-relative ordering, highlights and complete drill-down passed.');
} finally {
  await browser.close();
}
