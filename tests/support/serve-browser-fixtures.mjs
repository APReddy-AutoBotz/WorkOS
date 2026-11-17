import {fileURLToPath} from 'node:url';
import {startFixtureServer} from './compiled-fixture-server.mjs';

const fixtures = [
  'import-history-panel', 'project-import-ui', 'scoped-audit-history', 'organization-audit-history',
  'deployment-audit-history', 'utilization-reports', 'planned-utilization', 'actual-utilization',
  'forecast-utilization', 'organization-profile', 'terminology-configuration', 'working-calendar-inspector',
  'commercial-drafting', 'client-profiles',
];
const server = await startFixtureServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), fixtures, port: 4177,
  mode: 'development', publicEnv: {VITE_TERM_EMPLOYEE: process.env.VITE_TERM_EMPLOYEE || 'employee'},
});
console.log('Browser fixtures listening at ' + server.url);
