// Production worker/approver components and transport; no business interception.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import '../../src/index.css';
const Journey=()=>{
 const [view,setView]=useState('work');
 return <BrowserRouter><main className="mx-auto max-w-7xl p-5">
  <nav aria-label="Synthetic identical-entry navigation"><button onClick={()=>setView('work')}>Enter work</button><button onClick={()=>setView('review')}>Review work</button></nav>
  {view==='work'?<MyTimesheet/>:<TimesheetApproval/>}
 </main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Journey/>);
