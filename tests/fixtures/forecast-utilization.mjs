// Synthetic full-page acceptance harness. No real API, provider or production data.
// The actual CSV helper and import/export audit service remain in use. Only their
// network boundary is replaced, so successful exports still download real CSV.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {ForecastUtilization} from '../../src/pages/ForecastUtilization.tsx';
import {employeeService, projectService, allocationService, adminService, utilizationReportService} from '../../src/services/api.ts';
import {api, ApiClientError, resetBackendCheck} from '../../src/services/apiClient.ts';
import '../../src/index.css';

const root = createRoot(document.getElementById('root'));
const pending = [];
const calls = [];
const writes = [];
const legacyAuditCalls = [];
const healthReads = [];
const unexpectedFetches = [];
const captured = new Map();
const scope = {organizationId: 'synthetic-organization', legalEntityId: 'synthetic-legal-entity'};
let sequence = 0;
sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
const copy = value => JSON.parse(JSON.stringify(value));
const request = (reader, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  calls.push({id, reader, args});
  pending.push({id, reader, args, resolve, reject});
});
employeeService.getAll = (...args) => request('employees', args);
projectService.getAll = (...args) => request('projects', args);
allocationService.getAll = (...args) => request('allocations', args);
utilizationReportService.getForecast = (...args) => request('forecast', args);
adminService.getSettings = (...args) => request('settings', args);
adminService.logAction = async (...args) => { legacyAuditCalls.push(copy(args)); };

// checkBackend is retained, but its sole synthetic health response never leaves
// this page. Any unanticipated fetch fails closed and is asserted by the test.
window.fetch = async (url, init = {}) => {
  if (url === '/api/health' && (!init.method || init.method === 'GET')) {
    healthReads.push({url, method: init.method || 'GET'});
    return new Response(JSON.stringify({database: 'connected'}), {status: 200});
  }
  unexpectedFetches.push({url: String(url), method: init.method || 'GET'});
  throw new Error('Unexpected network request in synthetic forecast fixture');
};
resetBackendCheck();
api.postWithScope = async (path, body, expectedScope) => {
  writes.push(copy({path, body, scope: expectedScope}));
  if (path === '/api/import-export-logs') return [{
    id: `synthetic-export-${writes.length}`,
    operation: body.operation,
    channel: body.channel,
    file_name: body.fileName,
    status: body.status,
    total_rows: body.totalRows,
    valid_rows: body.validRows,
    error_rows: body.errorRows,
    user_name: 'Synthetic Export Actor',
    created_at: '2026-10-20T00:00:00Z',
  }];
  if (path === '/api/audit-events') return {id: `synthetic-audit-${writes.length}`};
  throw new Error('Unexpected synthetic write target');
};

const buttonHandler = name => {
  const button = [...document.querySelectorAll('button')].find(element =>
    element.getAttribute('aria-label') === name || element.textContent.trim().replace(/\s+/g, ' ') === name);
  if (!button) throw new Error(`Synthetic button not found: ${name}`);
  const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'));
  const handler = propsKey && button[propsKey].onClick;
  if (typeof handler !== 'function') throw new Error(`Synthetic button has no React click handler: ${name}`);
  return handler;
};
const render = () => root.render(React.createElement(BrowserRouter, null, React.createElement(ForecastUtilization)));
window.forecastHarness = {
  pending,
  calls,
  writes,
  legacyAuditCalls,
  healthReads,
  unexpectedFetches,
  scope,
  settle(id, result, status) {
    const index = pending.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Synthetic forecast request not found');
    const [item] = pending.splice(index, 1);
    const privateMessage = 'synthetic-private-password-token /internal/provider?credential=synthetic-secret';
    if (status === 'network') item.reject(new TypeError(privateMessage));
    else if (status) item.reject(new ApiClientError(privateMessage, {
      status,
      code: 'SYNTHETIC_PRIVATE_ERROR_CODE',
      correlationId: 'synthetic-private-correlation',
      operationId: 'synthetic-private-operation',
    }));
    else item.resolve(result);
  },
  capture(name, label) { captured.set(label, buttonHandler(name)); },
  invoke(labels) {
    for (const label of labels) {
      if (!captured.has(label)) throw new Error('Synthetic captured callback not found');
      captured.get(label)();
    }
  },
  horizonAndInvoke(name, labels) {
    // Invoke the actual selection callback and retained exports in one JS turn,
    // before React can rerender or start the selected-horizon effect.
    buttonHandler(name)();
    this.invoke(labels);
  },
  refreshAndInvoke(labels) {
    // Run the actual refresh callback and old export callbacks in the same turn,
    // before React can disable/remove the buttons. DOM disablement alone cannot
    // satisfy this generation-invalidated evidence check.
    buttonHandler('Refresh forecast utilization')();
    this.invoke(labels);
  },
  hide() { root.render(null); },
  show: render,
};
render();
