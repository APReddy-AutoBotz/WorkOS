import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectContribution} from '../../src/components/ProjectContribution';
import {authService} from '../../src/services/authService';
import {calculateProjectContribution} from '../../shared/project-contribution.mjs';
import {projectContributionCsv} from '../../shared/project-contribution-artifact.mjs';
import '../../src/index.css';

const user = {id: 'synthetic-project-user', employeeId: 'synthetic-worker', role: 'Admin', permissionRole: 'Admin', permissions: ['projects.view', 'employees.view', 'reports.view_utilization', 'reports.export']};
authService.getCurrentUser = () => user as ReturnType<typeof authService.getCurrentUser>;
sessionStorage.setItem('workos_session', JSON.stringify(user));
sessionStorage.setItem('workos_api_token', 'synthetic-project-browser');
const scope = {organizationId: 'synthetic-org', legalEntityId: 'synthetic-legal'};
sessionStorage.setItem('workos_organization_scope', JSON.stringify(scope));
const pending: Array<{url: URL; init?: RequestInit; resolve: (response: Response) => void}> = [];
const calls: Array<{url: string; method: string; body: unknown}> = [];
let observation: ReturnType<typeof calculateProjectContribution> & {sourceToken: string; observedAt: string};
let retained: Record<string, unknown> | null = null, csv = '';
window.fetch = async (input, init) => new Promise(resolve => {calls.push({url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null}); pending.push({url: new URL(String(input), location.origin), init, resolve});});
const settle = async (outcome: string) => {
  const request = pending.shift(); if (!request) throw Error('No pending synthetic project request');
  const reply = (body: unknown, status = 200) => request.resolve(new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}}));
  if (['retained', 'committed-unconfirmed'].includes(outcome)) {
    const input = JSON.parse(String(request.init?.body)), id = crypto.randomUUID();
    csv = projectContributionCsv(scope, observation);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csv)))).map(value => value.toString(16).padStart(2, '0')).join('');
    retained = {id, requestId: input.requestId, createdAt: '2026-10-25T13:00:00.000Z', activeRole: 'Admin', source: 'Web', reason: input.reason,
      result: observation, artifact: {fileName: `project-contribution-${id}.csv`, sha256, bytes: new TextEncoder().encode(csv).length}};
    return outcome === 'committed-unconfirmed' ? reply({error: 'Synthetic interrupted acknowledgement'}, 503) : reply({contractVersion: 'project-contribution/1', ...scope, projectId: observation.projectId, evidence: retained, csv, replayed: false}, 201);
  }
  const envelope = observation && {contractVersion: 'project-contribution/1', ...scope, projectId: observation.projectId};
  if (outcome === 'receipt') return reply({...envelope, evidence: retained});
  if (outcome === 'missing-receipt') return reply({code: 'PROJECT_EVIDENCE_NOT_FOUND', error: 'Unconfirmed synthetic receipt'}, 404);
  if (outcome === 'history') return reply({...envelope, startsOn: observation.startsOn, endsOn: observation.endsOn, evidence: retained ? [retained] : [], nextBefore: null});
  if (outcome === 'artifact' || outcome === 'corrupt-artifact') return reply({...envelope, evidence: retained, csv: outcome === 'artifact' ? csv : csv + 'corruption'});
  if (outcome === 'failed' || outcome === 'denied') {request.resolve(new Response(JSON.stringify({error: 'Synthetic private failure detail'}), {status: outcome === 'failed' ? 503 : 403})); return;}
  const projectId = request.url.pathname.split('/').at(-2)!, startsOn = request.url.searchParams.get('startsOn')!, endsOn = request.url.searchParams.get('endsOn')!;
  const employeeId = 'synthetic-worker';
  const capacity = {employeeId, startsOn, endsOn, status: 'available', totals: {eligibleHoursExact: '8'}, days: [{eligibleHoursExact: '8', status: 'available'}]};
  const worker = {employeeId, capacity, rows: [{id: 'entry', date: startsOn, status: 'Approved', hoursExact: '2', disposition: outcome === 'unresolved' ? 'unresolved' : 'included', reason: outcome === 'unresolved' ? 'APPROVAL_EVIDENCE_UNAVAILABLE' : null}]};
  const result = {...calculateProjectContribution({projectId, startsOn, endsOn, workers: outcome === 'empty' ? [] : [worker]}), sourceToken: 'a'.repeat(64), observedAt: '2026-10-25T12:00:00Z'};
  observation = result;
  request.resolve(new Response(JSON.stringify({contractVersion: 'project-contribution/1', ...scope, project: {id: projectId, name: `Synthetic ${projectId}`}, workers: outcome === 'empty' ? [] : [{id: employeeId, code: 'SYN', name: 'Synthetic worker'}], result}), {status: 200, headers: {'Content-Type': 'application/json'}}));
};
(window as unknown as {projectContributionHarness: unknown}).projectContributionHarness = {pending: () => pending.length, settle, calls: () => calls};
const App = () => {const [id, setId] = useState('alpha'), [visible, setVisible] = useState(true); return <main className="p-6"><button onClick={() => setId(id === 'alpha' ? 'beta' : 'alpha')}>Change project</button><button onClick={() => setVisible(!visible)}>Toggle report</button>{visible && <ProjectContribution projectId={id}/>}</main>;};
createRoot(document.getElementById('root')!).render(<App/>);
