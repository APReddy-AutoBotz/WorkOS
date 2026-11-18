import React from 'react';
import { createRoot } from 'react-dom/client';
import { MilestoneBillingWorkspace } from '../../src/components/MilestoneBillingWorkspace';
const engagement = new URLSearchParams(location.search).get('engagement')!;
createRoot(document.getElementById('root')!).render(
  <MilestoneBillingWorkspace choices={[{ id: engagement, label: 'Synthetic milestone engagement' }]} />,
);
