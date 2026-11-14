// Synthetic browser acceptance. The production editor, authentication reader,
// adminService and API client are deliberately NOT replaced. Only fetch is gated
// so assertions inspect the exact production request headers, body and ordering.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {OrganizationProfileEditor} from '../../src/pages/OrganizationProfileEditor.tsx';
import {resetBackendCheck} from '../../src/services/apiClient.ts';
import '../../src/index.css';

const root = createRoot(document.getElementById('root'));
const pending = [];
const calls = [];
const unexpectedFetches = [];
const captured = new Map();
let sequence = 0;
const session = (id = 'synthetic-admin-a', role = 'Admin', allowed = true) => ({
  id, employeeId: id, userName: id, name: 'Synthetic Profile Administrator',
  email: 'profile-admin@example.invalid', role, availableRoles: [role],
  permissionRole: role, permissions: allowed ? ['settings.manage'] : [],
  lastLogin: '2026-10-20T00:00:00Z',
});
const initialScope = {organizationId: 'org-a', legalEntityId: 'legal-a'};
const token = crypto.randomUUID();
sessionStorage.setItem('workos_session', JSON.stringify(session('synthetic-admin-a', 'Admin', new URLSearchParams(window.location.search).get('access') !== 'none')));
sessionStorage.setItem('workos_organization_scope', JSON.stringify(initialScope));
sessionStorage.setItem('workos_api_token', token);

const emit = (event, key) => {
  if (event === 'storage') window.dispatchEvent(new StorageEvent('storage', {key, storageArea: sessionStorage, url: window.location.href}));
  else if (event) window.dispatchEvent(new Event(event));
};
window.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers || (input instanceof Request ? input.headers : undefined)).entries());
  const kind = url.pathname === '/api/health' && method === 'GET' ? 'health'
    : url.pathname === '/api/organization-setup/profile' && method === 'GET' ? 'profile'
    : url.pathname === '/api/organization-setup/profile' && method === 'PUT' ? 'save'
    : url.pathname === '/api/organization-setup/readiness' && method === 'GET' ? 'readiness' : null;
  const call = {
    id: ++sequence, kind, url: `${url.pathname}${url.search}`, method, headers,
    credentials: init.credentials || (input instanceof Request ? input.credentials : undefined),
    body: init.body === undefined ? null : JSON.parse(String(init.body)),
  };
  calls.push(call);
  if (url.origin !== window.location.origin || !kind) {
    unexpectedFetches.push(call);
    return Promise.reject(new Error('Unexpected synthetic organization-profile network target'));
  }
  // A controlled gate, not an alternate service: Response parsing and all
  // status/context behavior remain the responsibility of the real API client.
  return new Promise((resolve, reject) => pending.push({...call, resolve, reject}));
};
resetBackendCheck();

const reactHandler = (element, name) => {
  if (!element) throw new Error(`Synthetic ${name} element is missing`);
  const key = Object.keys(element).find(key => key.startsWith('__reactProps$'));
  const handler = key && element[key][name];
  if (typeof handler !== 'function') throw new Error(`Synthetic React ${name} handler is missing`);
  return handler;
};
const submitHandler = () => reactHandler(document.querySelector('form'), 'onSubmit');
const reloadHandler = () => reactHandler([...document.querySelectorAll('button')].find(button =>
  button.getAttribute('aria-label') === 'Reload profile' || button.textContent.trim() === 'Reload profile'), 'onClick');
const invoke = labels => {
  for (const label of labels) {
    const handler = captured.get(label);
    if (!handler) throw new Error(`Synthetic retained callback is missing: ${label}`);
    handler({preventDefault() {}, currentTarget: document.querySelector('form')});
  }
};
const strict = new URLSearchParams(window.location.search).get('strict') === '1';
const render = () => root.render(React.createElement(strict ? React.StrictMode : React.Fragment, null,
  React.createElement(BrowserRouter, null, React.createElement(OrganizationProfileEditor))));
window.organizationProfileHarness = {
  pending, calls, unexpectedFetches, initialScope, syntheticToken: token,
  settle(id, result, status) {
    const index = pending.findIndex(call => call.id === id);
    if (index < 0) throw new Error('Synthetic profile request is missing');
    const [call] = pending.splice(index, 1);
    const privateMessage = 'synthetic-private-password-token /internal/provider?credential=synthetic-secret';
    if (status === 'network') call.reject(new TypeError(privateMessage));
    else call.resolve(new Response(JSON.stringify(status ? {error: {
      message: privateMessage, code: 'SYNTHETIC_PRIVATE_ERROR_CODE',
      correlationId: 'synthetic-private-correlation', operationId: 'synthetic-private-operation',
    }} : result), {status: status || 200, headers: {
      'Content-Type': 'application/json', 'X-Correlation-ID': 'synthetic-private-correlation',
    }}));
  },
  capture(label, kind = 'submit') { captured.set(label, kind === 'reload' ? reloadHandler() : submitHandler()); },
  invoke,
  submitTwice() {
    const handler = submitHandler();
    const event = {preventDefault() {}, currentTarget: document.querySelector('form')};
    handler(event);
    handler(event);
  },
  reloadAndInvoke(labels) { reloadHandler()(); invoke(labels); },
  scope(organizationId, legalEntityId, event = 'workos:organization-scope-changed', labels = []) {
    if (organizationId) sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId, legalEntityId}));
    else sessionStorage.removeItem('workos_organization_scope');
    emit(event, 'workos_organization_scope');
    invoke(labels);
  },
  identity(id = 'synthetic-admin-a', role = 'Admin', allowed = true, event = 'focus', labels = []) {
    sessionStorage.setItem('workos_session', JSON.stringify(session(id, role, allowed)));
    emit(event, 'workos_session');
    invoke(labels);
  },
  token(next, event = 'focus', labels = []) {
    sessionStorage.setItem('workos_api_token', next);
    emit(event, 'workos_api_token');
    invoke(labels);
  },
  event(event, labels = []) { emit(event); invoke(labels); },
  resetHealth() { resetBackendCheck(); },
  hide() { root.render(null); },
  show: render,
};
render();
