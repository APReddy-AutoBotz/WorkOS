import React from 'react';
import {createRoot} from 'react-dom/client';
import {InvoiceBillingConfirmation} from '../../src/components/InvoiceBillingConfirmation';

createRoot(document.getElementById('root')!).render(<InvoiceBillingConfirmation choices={[{id:'synthetic-engagement',label:'Synthetic milestone engagement'}]}/>);
