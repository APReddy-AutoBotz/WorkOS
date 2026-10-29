import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReviewedInvoiceBatch} from '../../src/components/ReviewedInvoiceBatch';

createRoot(document.getElementById('root')!).render(<ReviewedInvoiceBatch choices={[{id:'synthetic-engagement',label:'Synthetic milestone engagement'}]}/>);
