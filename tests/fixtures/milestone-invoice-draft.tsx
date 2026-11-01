import React from 'react';
import {createRoot} from 'react-dom/client';
import {InvoiceDraftWorkspace} from '../../src/components/InvoiceDraftWorkspace';

const q=new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(<InvoiceDraftWorkspace choices={[{id:q.get('engagement')||'synthetic-engagement',label:'Synthetic milestone engagement',clientId:q.get('client')||'synthetic-client',contractId:q.get('contract')||'synthetic-contract',currency:'USD',sourceType:'MILESTONE_ACCEPTANCE'}]}/>);
