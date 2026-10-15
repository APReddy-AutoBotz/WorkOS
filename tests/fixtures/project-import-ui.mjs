import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {Header} from '../../src/components/Layout/Header.tsx';
import {ImportExport} from '../../src/pages/ImportExport.tsx';
import {ReportsCenter} from '../../src/pages/ReportsCenter.tsx';

const page = new URLSearchParams(window.location.search).get('view') === 'reports'
  ? React.createElement(ReportsCenter)
  : React.createElement(ImportExport);

createRoot(document.getElementById('root')).render(
  React.createElement(BrowserRouter, null, React.createElement(React.Fragment, null, React.createElement(Header), page)),
);
