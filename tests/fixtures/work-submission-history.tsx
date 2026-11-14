// Production workspace/history components and real transport; synthetic navigation only.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import {WorkSubmissionHistory} from '../../src/components/WorkSubmissionHistory';
import '../../src/index.css';
const Journey=()=>{const [view,setView]=useState('work');return <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic history navigation"><button onClick={()=>setView('work')}>Enter work</button><button onClick={()=>setView('review')}>Review work</button><button onClick={()=>setView('legacy')}>Inspect legacy work</button></nav><div key={view}>{view==='work'?<MyTimesheet/>:view==='review'?<TimesheetApproval/>:<WorkSubmissionHistory timesheetId="9d2644d5-68c8-4da5-a7f0-6c77800cf512"/>}</div></main></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Journey/>);
