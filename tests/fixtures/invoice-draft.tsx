import React from 'react';
import { createRoot } from 'react-dom/client';
import { InvoiceDraftWorkspace } from '../../src/components/InvoiceDraftWorkspace';
const q = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(
  <InvoiceDraftWorkspace
    choices={[
      {
        id: q.get('engagement')!,
        label: 'Synthetic engagement',
        clientId: q.get('client')!,
        contractId: q.get('contract')!,
        currency: 'USD',
      },
    ]}
  />,
);
