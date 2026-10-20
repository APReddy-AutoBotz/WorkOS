// The production React component, auth reader, normalizers and HTTP transport.
// There is deliberately no mock data, request interception or fallback service.
// The hosted journey injects a signed synthetic identity for its disposable DB.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {CommercialAmendmentWorkspace} from '../../src/components/CommercialAmendmentWorkspace';
import '../../src/index.css';

const root = createRoot(document.getElementById('root')!);
const captured = new Map<string, (...args: any[]) => unknown>();
const reactHandler = (element: Element | null | undefined, name: string) => {
  if (!element) throw new Error(`Synthetic ${name} target missing`);
  const key = Object.keys(element).find(key => key.startsWith('__reactProps$'));
  const handler = key && (element as any)[key][name];
  if (typeof handler !== 'function') throw new Error(`Synthetic React ${name} handler missing`);
  return handler;
};
const emit = (event: string | null) => {
  if (event === 'storage') window.dispatchEvent(new StorageEvent('storage', {key: 'workos_session', storageArea: sessionStorage}));
  else if (event) window.dispatchEvent(new Event(event));
};
const invoke = (labels: string[]) => labels.forEach(label => {
  const handler = captured.get(label);
  if (!handler) throw new Error(`Synthetic captured handler ${label} missing`);
  handler({preventDefault() {}, currentTarget: document.querySelector('form')});
});
(window as any).commercialAmendmentHarness = {
  capture(label: string, button?: string) {
    captured.set(label, button
      ? reactHandler([...document.querySelectorAll('button')].find(element => element.textContent?.trim() === button), 'onClick')
      : reactHandler(document.querySelector('form'), 'onSubmit'));
  },
  scope(value: unknown, event: string | null = 'workos:organization-scope-changed', labels: string[] = []) {
    sessionStorage.setItem('workos_organization_scope', JSON.stringify(value));emit(event);invoke(labels);
  },
  identity(value: unknown, event: string | null = 'focus', labels: string[] = []) {
    sessionStorage.setItem('workos_session', JSON.stringify(value));emit(event);invoke(labels);
  },
  token(value: string | null, event: string | null = 'focus', labels: string[] = []) {
    if (value === null) sessionStorage.removeItem('workos_api_token');else sessionStorage.setItem('workos_api_token', value);
    emit(event);invoke(labels);
  },
  invoke,
  event: emit,
};
root.render(<BrowserRouter><CommercialAmendmentWorkspace /></BrowserRouter>);
