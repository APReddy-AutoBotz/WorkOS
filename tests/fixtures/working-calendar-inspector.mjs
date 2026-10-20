// Keep production page, context, auth, service and API client real. Only fetch
// Responses are gated. No business mutation request is permitted by this fixture.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {WorkingCalendarInspector} from '../../src/pages/WorkingCalendarInspector.tsx';
import {resetBackendCheck} from '../../src/services/apiClient.ts';
import '../../src/index.css';
const root = createRoot(document.getElementById('root'));
const pending = [], calls = [], unexpectedFetches = [], captured = new Map();
const params = new URLSearchParams(location.search);
let sequence = 0;
const session = (id='synthetic-calendar-admin',role='HR',allowed=true) => ({id,employeeId:id,name:'Synthetic Calendar Operator',role,permissionRole:role,permissions:allowed?['settings.manage']:[]});
sessionStorage.setItem('workos_session',JSON.stringify(session(undefined,undefined,params.get('access')!=='none')));
sessionStorage.setItem('workos_organization_scope',JSON.stringify({organizationId:'org-a',legalEntityId:'legal-a'}));
sessionStorage.setItem('workos_api_token','synthetic-calendar-token-a');
window.fetch = (input, init={}) => {
  const url = new URL(typeof input==='string'?input:input.url,location.origin);
  const method = String(init.method || 'GET').toUpperCase();
  const kind = method==='GET' && url.pathname==='/api/health'?'health'
    : method==='GET' && url.pathname==='/api/organization-setup/calendars'?'calendars'
      : method==='GET' && /^\/api\/organization-setup\/calendars\/[^/]+\/holidays$/.test(url.pathname)?'holidays':null;
  const call={id:++sequence,kind,url:url.pathname+url.search,method,headers:Object.fromEntries(new Headers(init.headers).entries()),credentials:init.credentials,body:init.body ?? null};
  calls.push(call);
  if(url.origin!==location.origin || !kind){unexpectedFetches.push(call);return Promise.reject(new Error('Unexpected calendar target or mutation'));}
  return new Promise((resolve,reject)=>pending.push({...call,resolve,reject}));
};
resetBackendCheck();
const handler = name => {
  const element=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===name);
  if(!element)throw new Error(`Missing synthetic button ${name}`);
  const props=Object.keys(element).find(key=>key.startsWith('__reactProps$'));
  if(typeof element[props]?.onClick!=='function')throw new Error('Missing React click handler');
  return element[props].onClick;
};
const emit = event => {if(event==='storage')window.dispatchEvent(new StorageEvent('storage',{key:'workos_session',storageArea:sessionStorage}));else if(event)window.dispatchEvent(new Event(event));};
const invoke = labels => labels.forEach(label=>{if(!captured.has(label))throw new Error(`Missing captured callback ${label}`);captured.get(label)();});
const render = () => root.render(React.createElement(params.get('strict')==='1'?React.StrictMode:React.Fragment,null,
  React.createElement(BrowserRouter,null,React.createElement(WorkingCalendarInspector))));
window.workingCalendarHarness = {pending,calls,unexpectedFetches,
  settle(id,result,status){const index=pending.findIndex(item=>item.id===id);if(index<0)throw new Error('Missing pending calendar request');const [call]=pending.splice(index,1);
    if(status==='network')call.reject(new TypeError('synthetic-private-token /internal/provider'));
    else if(status==='malformed-json')call.resolve(new Response('synthetic-private-invalid-json',{status:200}));
    else call.resolve(new Response(JSON.stringify(status?{error:'synthetic-private-token /internal/provider'}:result),{status:status||200,headers:{'Content-Type':'application/json'}}));},
  capture(label,name){captured.set(label,handler(name));},invoke,
  clickTwice(name){const click=handler(name);click();click();},
  scope(value,event='workos:organization-scope-changed',labels=[]){sessionStorage.setItem('workos_organization_scope',JSON.stringify(value));emit(event);invoke(labels);},
  identity(id='synthetic-calendar-admin',role='HR',allowed=true,event='focus',labels=[]){sessionStorage.setItem('workos_session',JSON.stringify(session(id,role,allowed)));emit(event);invoke(labels);},
  token(value,event='focus',labels=[]){if(value===null)sessionStorage.removeItem('workos_api_token');else sessionStorage.setItem('workos_api_token',value);emit(event);invoke(labels);},
  event(event,labels=[]){emit(event);invoke(labels);},
  reloadAndInvoke(labels=[]){handler('Reload calendars')();invoke(labels);},
  hide(){root.render(null);},show:render,
};
render();
