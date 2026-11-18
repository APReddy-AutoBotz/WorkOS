// Synthetic navigation only; production components and owned HTTP transport.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {WorkCapturePolicyEditor} from '../../src/pages/WorkCapturePolicyEditor';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import {ImportExport} from '../../src/pages/ImportExport';
import '../../src/index.css';
const Journey=()=>{const[view,setView]=useState('work');return <BrowserRouter><main className="mx-auto max-w-7xl p-4"><nav><button onClick={()=>setView('work')}>Capture classified work</button><button onClick={()=>setView('settings')}>Configure work categories</button><button onClick={()=>setView('review')}>Review classified work</button><button onClick={()=>setView('import')}>Import classified work</button></nav><div key={view}>{view==='work'?<MyTimesheet/>:view==='settings'?<WorkCapturePolicyEditor/>:view==='review'?<TimesheetApproval/>:<ImportExport/>}</div></main></BrowserRouter>;};createRoot(document.getElementById('root')!).render(<Journey/>);
