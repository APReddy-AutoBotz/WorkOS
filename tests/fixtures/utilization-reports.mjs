// Synthetic full-page read harness. No provider calls, production records or writes.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {UtilizationReports} from '../../src/pages/UtilizationReports.tsx';
import {adminService, utilizationReportService} from '../../src/services/api.ts';
import {ApiClientError} from '../../src/services/apiClient.ts';
import '../../src/index.css';

const root = createRoot(document.getElementById('root'));
const pending = [];
const calls = [];
let sequence = 0;
let writes = 0;
const request = (lens, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  calls.push({id, lens, args});
  pending.push({id, lens, resolve, reject});
});
utilizationReportService.getPlanned = (...args) => request('planned', args);
utilizationReportService.getActual = (...args) => request('actual', args);
utilizationReportService.getForecast = (...args) => request('forecast', args);
adminService.logAction = async () => { writes += 1; };
const render = () => root.render(React.createElement(BrowserRouter, null, React.createElement(UtilizationReports)));
window.utilizationHarness = {
  pending,
  calls,
  writes: () => writes,
  settle(id, report, status) {
    const index = pending.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Synthetic utilization request not found');
    const [item] = pending.splice(index, 1);
    if (status === 'network') item.reject(new TypeError('synthetic-private-password-token /internal/provider?credential=synthetic-secret'));
    else if (status) item.reject(new ApiClientError('synthetic-private-password-token /internal/provider?credential=synthetic-secret', {
      status,
      code: 'SYNTHETIC_PRIVATE_ERROR_CODE',
      correlationId: 'synthetic-private-correlation',
      operationId: 'synthetic-private-operation',
    }));
    else item.resolve(report);
  },
  hide() { root.render(null); },
  show: render,
};
render();
