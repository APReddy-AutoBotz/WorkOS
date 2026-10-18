// Controlled synthetic read-only designation/history requests; no provider or application data.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AuditTrail} from '../../src/pages/AuditTrail.tsx';
import {adminService} from '../../src/services/api.ts';
import {authService} from '../../src/services/authService.ts';
import {ApiClientError} from '../../src/services/apiClient.ts';
import '../../src/index.css';
const root = createRoot(document.getElementById('root'));
let actor = 'synthetic-reader-one';
let role = 'HR';
let allowed = true;
let sequence = 0;
let forbiddenReads = 0;
let writes = 0;
const pending = [];
authService.getCurrentUser = () => ({id: actor, employeeId: actor, role, permissionRole: role, permissions: allowed ? ['audit.organization.view'] : []});
const load = (kind, organizationId) => new Promise((resolve, reject) => pending.push({id: ++sequence, kind, organizationId, actor, role, resolve, reject}));
adminService.getOrganizationAuditScopesForHistory = () => load('scopes');
adminService.getOrganizationAuditLogsForHistory = organizationId => load('history', organizationId);
adminService.getScopedAuditHistory = async () => { forbiddenReads += 1; return []; };
adminService.getDeploymentAuditLogs = async () => { forbiddenReads += 1; return []; };
adminService.getDeploymentIntegrationEvents = async () => { forbiddenReads += 1; return []; };
adminService.logAction = async () => { writes += 1; };
const render = () => root.render(React.createElement(BrowserRouter, null, React.createElement(AuditTrail)));
window.organizationAuditHarness = {
  pending,
  observations: () => ({forbiddenReads, writes, requests: sequence}),
  settle(id, rows, status) {
    const index = pending.findIndex(request => request.id === id);
    if (index < 0) throw new Error('Synthetic request missing');
    const [request] = pending.splice(index, 1);
    if (status === 'network') request.reject(new TypeError('private-password-token'));
    else if (status) request.reject(new ApiClientError('private-password-token', {status}));
    else request.resolve(rows);
  },
  identity(nextActor, nextRole = 'HR', permission = true) { actor = nextActor; role = nextRole; allowed = permission; render(); },
  hide() { root.render(null); },
  show: render,
};
render();
