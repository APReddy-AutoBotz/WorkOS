import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReviewedInvoiceBatch} from '../../src/components/ReviewedInvoiceBatch';

const ids = new URLSearchParams(window.location.search).getAll('engagement');
const choices = ids.length ? ids.map((id,index)=>({id,label:`Synthetic engagement ${index+1}`})) : [{id:'synthetic-engagement',label:'Synthetic milestone engagement'}];
createRoot(document.getElementById('root')!).render(<ReviewedInvoiceBatch choices={choices}/>);
