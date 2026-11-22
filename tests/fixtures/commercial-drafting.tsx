// The actual React workspace, auth reader, DTO normalizers and transport run here.
// Only fetch is gated in the mock journey. ?live=1 preserves an injected signed
// synthetic session and the native fetch for the disposable-PostgreSQL journey.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {CommercialDraftingWorkspace} from '../../src/pages/CommercialDraftingWorkspace';
import {verifyServiceInvoiceCsv} from '../../src/services/milestoneInvoiceCsv';
import '../../src/index.css';

Object.assign(window,{verifyServiceInvoiceCsv});

const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(location.search);
const pending: any[] = [], calls: any[] = [], unexpectedFetches: any[] = [];
const captured = new Map<string, (...args: any[]) => unknown>();
let sequence = 0;
const permissions = (access = 'manage') => access === 'none' ? [] : access === 'read' ? ['commercial.contracts.view'] : ['commercial.contracts.view', 'commercial.contracts.manage'];
const session = (id = 'synthetic-commercial-admin', role = 'ProjectManager', access = 'manage') => ({id, employeeId: id, name: 'Synthetic Commercial Operator', role, permissionRole: role, permissions: permissions(access)});
if (params.get('live') !== '1') {
  sessionStorage.setItem('workos_session', JSON.stringify(session(undefined, undefined, params.get('access') || 'manage')));
  sessionStorage.setItem('workos_organization_scope', JSON.stringify({organizationId: 'org-a', legalEntityId: 'legal-a'}));
  sessionStorage.setItem('workos_api_token', 'example-commercial-token-a');
  window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
    const method = String(init.method || 'GET').toUpperCase();
    const prefix = '/api/v1/commercial-drafting';
    const kind = method === 'GET' && url.pathname === `${prefix}/workspace` ? 'workspace'
      : method === 'GET' && new RegExp(`^${prefix}/contracts/[^/]+$`).test(url.pathname) ? 'contract'
      : method === 'POST' && url.pathname === `${prefix}/contracts` ? 'create-contract'
      : method === 'POST' && new RegExp(`^${prefix}/contracts/[^/]+/versions$`).test(url.pathname) ? 'append-version'
      : method === 'POST' && url.pathname === `${prefix}/engagements` ? 'create-engagement'
      : method === 'POST' && url.pathname === `${prefix}/purchase-orders` ? 'create-po'
      : method === 'POST' && url.pathname === `${prefix}/milestones` ? 'create-milestone' : null;
    const call = {id: ++sequence, kind, url: url.pathname + url.search, method, headers: Object.fromEntries(new Headers(init.headers).entries()),
      credentials: init.credentials, body: init.body === undefined ? null : JSON.parse(String(init.body))};
    calls.push(call);
    if (url.origin !== location.origin || !kind) {unexpectedFetches.push(call);return Promise.reject(new Error('Unexpected synthetic commercial target'));}
    return new Promise<Response>((resolve, reject) => pending.push({...call, resolve, reject}));
  }) as typeof fetch;
}
const reactHandler = (element: Element | undefined | null, name: string) => {
  if (!element) throw new Error(`Synthetic ${name} element missing`);
  const key = Object.keys(element).find(key => key.startsWith('__reactProps$'));
  const handler = key && (element as any)[key][name];
  if (typeof handler !== 'function') throw new Error(`Synthetic React ${name} handler missing`);
  return handler;
};
const buttonHandler = (name: string) => reactHandler([...document.querySelectorAll('button')].find(element => element.textContent?.trim() === name), 'onClick');
const emit = (event: string | null) => {
  if (event === 'storage') window.dispatchEvent(new StorageEvent('storage', {key: 'workos_session', storageArea: sessionStorage}));
  else if (event) window.dispatchEvent(new Event(event));
};
const invoke = (labels: string[]) => labels.forEach(label => {
  const handler = captured.get(label);if (!handler) throw new Error(`Missing captured handler ${label}`);
  handler({preventDefault() {}, currentTarget: document.querySelector('form')});
});
const render = () => root.render(React.createElement(params.get('strict') === '1' ? React.StrictMode : React.Fragment, null,
  React.createElement(BrowserRouter, null, React.createElement(CommercialDraftingWorkspace))));
(window as any).commercialHarness = {pending, calls, unexpectedFetches,
  settle(id: number, result: unknown, status?: number | string) {
    const index = pending.findIndex(call => call.id === id);if (index < 0) throw new Error('Missing pending commercial request');
    const [call] = pending.splice(index, 1);
    const privateError = 'synthetic-private-password-token /internal/provider';
    if (status === 'network') call.reject(new TypeError(privateError));
    else if (status === 'malformed-json') call.resolve(new Response('{invalid synthetic-private json', {status: 200}));
    else call.resolve(new Response(JSON.stringify(status ? {error: {message: privateError, code: 'SYNTHETIC_PRIVATE'}} : result), {status: typeof status === 'number' ? status : 200, headers: {'Content-Type': 'application/json'}}));
  },
  capture(label: string, name: string) {captured.set(label, name === 'submit' ? reactHandler(document.querySelector('form'), 'onSubmit') : buttonHandler(name));}, invoke,
  submitTwice() {const submit = reactHandler(document.querySelector('form'), 'onSubmit');const event = {preventDefault() {}, currentTarget: document.querySelector('form')};submit(event);submit(event);},
  clickTwice(name: string) {const click = buttonHandler(name);click();click();},
  scope(value: unknown, event = 'workos:organization-scope-changed', labels: string[] = []) {sessionStorage.setItem('workos_organization_scope', JSON.stringify(value));emit(event);invoke(labels);},
  identity(id = 'synthetic-commercial-admin', role = 'ProjectManager', access = 'manage', event: string | null = 'focus', labels: string[] = []) {sessionStorage.setItem('workos_session', JSON.stringify(session(id, role, access)));emit(event);invoke(labels);},
  token(value: string | null, event: string | null = 'focus', labels: string[] = []) {if (value === null) sessionStorage.removeItem('workos_api_token');else sessionStorage.setItem('workos_api_token', value);emit(event);invoke(labels);},
  event: emit, hide() {root.render(null);}, show: render,
};
render();
