// Synthetic component harness only; never connects to application or provider data.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ImportHistoryPanel} from '../../src/components/imports/ImportHistoryPanel.tsx';
import '../../src/index.css';

const root = createRoot(document.getElementById('root'));
let revision = 0;
const pending = [];
const loadHistory = () => new Promise((resolve, reject) => pending.push({resolve, reject}));
const render = () => root.render(React.createElement('main', {style: {maxWidth: '640px', margin: '16px auto'}},
  React.createElement(ImportHistoryPanel, {loadHistory, revision})));
window.historyHarness = {
  pending,
  refresh() { revision += 1; render(); },
  hide() { root.render(null); },
  show: render,
};
render();
