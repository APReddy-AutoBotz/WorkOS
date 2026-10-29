import React from 'react';
import {createRoot} from 'react-dom/client';
import {InvoiceDraftWorkspace} from '../../src/components/InvoiceDraftWorkspace';

createRoot(document.getElementById('root')!).render(<InvoiceDraftWorkspace choices={[{id:'synthetic-engagement',label:'Synthetic milestone engagement',clientId:'synthetic-client',contractId:'synthetic-contract',currency:'USD',sourceType:'MILESTONE_ACCEPTANCE'}]}/>);
