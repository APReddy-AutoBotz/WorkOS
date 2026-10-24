// Synthetic navigation/session only; production pages, transport, API and SQL.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {ESSHome} from '../../src/pages/LeaveManagement';
import {ActualUtilization} from '../../src/pages/ActualUtilization';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import {ImportExport} from '../../src/pages/ImportExport';
import '../../src/index.css';
const Fixture=()=>{const[view,setView]=useState('work');return <BrowserRouter><main className="mx-auto max-w-7xl p-4"><nav><button onClick={()=>setView('work')}>Enter composite work</button><button onClick={()=>setView('own')}>Own selected period</button><button onClick={()=>setView('report')}>Actual report</button><button onClick={()=>setView('review')}>Review composite work</button><button onClick={()=>setView('import')}>Import composite work</button></nav><div key={view}>{view==='work'?<MyTimesheet/>:view==='own'?<ESSHome/>:view==='report'?<ActualUtilization/>:view==='review'?<TimesheetApproval/>:<ImportExport/>}</div></main></BrowserRouter>;};createRoot(document.getElementById('root')!).render(<Fixture/>);
