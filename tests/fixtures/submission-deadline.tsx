// Production components/transport; synthetic navigation only.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {WorkCapturePolicyEditor} from '../../src/pages/WorkCapturePolicyEditor';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import {ImportExport} from '../../src/pages/ImportExport';
import '../../src/index.css';
const Journey=()=>{const [view,setView]=useState('work');return <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic submission timing navigation"><button onClick={()=>setView('work')}>Enter work</button><button onClick={()=>setView('policy')}>Configure capture policy</button><button onClick={()=>setView('imports')}>Import work</button><button onClick={()=>setView('review')}>Review work</button></nav><div key={view}>{view==='work'?<MyTimesheet/>:view==='policy'?<WorkCapturePolicyEditor/>:view==='imports'?<ImportExport/>:<TimesheetApproval/>}</div></main></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Journey/>);
