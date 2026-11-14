// Synthetic navigation/session only. Production components, client, API and SQL.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectContribution} from '../../src/components/ProjectContribution';
import '../../src/index.css';
const projectId = new URLSearchParams(location.search).get('project') ?? '';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-6xl p-4"><ProjectContribution projectId={projectId}/></main>);
