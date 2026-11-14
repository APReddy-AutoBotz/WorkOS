// Real production form/import/approval components and services. The hosted test
// bootstraps only a synthetic signed session; no business request is mocked.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AllocationForm} from '../../src/components/forms/AllocationForm';
import {ImportExport} from '../../src/pages/ImportExport';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import '../../src/index.css';
const Journey=()=>{
  const [view,setView]=useState('allocation');
  return <BrowserRouter><main className="mx-auto max-w-7xl p-5">
    <nav aria-label="Synthetic acceptance navigation" className="mb-4 flex gap-4">
      <button onClick={()=>setView('allocation')}>Plan assignment</button>
      <button onClick={()=>setView('import')}>Import work</button>
      <button onClick={()=>setView('review')}>Review work</button>
    </nav>
    {view==='allocation'?<AllocationForm onClose={()=>setView('import')} />:view==='import'?<ImportExport />:<TimesheetApproval />}
  </main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Journey />);
