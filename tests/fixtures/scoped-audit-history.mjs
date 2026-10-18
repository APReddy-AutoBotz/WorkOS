// Synthetic UI harness. No application/provider requests or real audit records.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AuditTrail} from '../../src/pages/AuditTrail.tsx';
import {adminService} from '../../src/services/api.ts';
import {authService} from '../../src/services/authService.ts';
import {ApiClientError} from '../../src/services/apiClient.ts';
import '../../src/index.css';

const root = createRoot(document.getElementById('root'));
let allowed = true;
const deployment = new URLSearchParams(window.location.search).has('deployment');
let sequence = 0;
let writes = 0;
const pending = [];
authService.getCurrentUser = () => ({id: 'synthetic-reader', employeeId: 'AUDIT-TEST', role: 'HR', permissionRole: 'HR', permissions: allowed ? ['audit.view', ...(deployment ? ['audit.deployment.view'] : [])] : []});
adminService.getScopedAuditHistory = () => new Promise((resolve, reject) => pending.push({id: ++sequence, resolve, reject}));
adminService.getDeploymentAuditLogs = async () => [{id: 'deployment-evidence', timestamp: '2026-10-18T00:00:00Z', userId: 'system', userName: 'Synthetic Operator', userRole: 'HR', module: 'System', action: 'Update', entityId: 'deployment-evidence', details: 'Synthetic deployment evidence'}];
adminService.getDeploymentIntegrationEvents = async () => [];
adminService.logAction = async () => { writes += 1; };
const render = () => root.render(React.createElement(BrowserRouter, null, React.createElement(AuditTrail)));
window.auditHarness = {
  pending,
  writes: () => writes,
  settle(id, rows, status) {
    const index = pending.findIndex(request => request.id === id);
    if (index < 0) throw new Error('Synthetic request not found');
    const [request] = pending.splice(index, 1);
    if (status === 'network') request.reject(new TypeError('private-password-token'));
    else if (status) request.reject(new ApiClientError('private-password-token', {status}));
    else request.resolve(rows);
  },
  scope(organizationId, legalEntityId) {
    if (organizationId) sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId, legalEntityId}));
    else sessionStorage.removeItem('workos_organization_scope');
    window.dispatchEvent(new Event('workos:organization-scope-changed'));
  },
  permission(value) { allowed = value; render(); },
  hide() { root.render(null); },
  show: render,
};
render();
