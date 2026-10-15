import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {ImportExport} from '../../src/pages/ImportExport.tsx';

createRoot(document.getElementById('root')).render(
  React.createElement(BrowserRouter, null, React.createElement(ImportExport)),
);
