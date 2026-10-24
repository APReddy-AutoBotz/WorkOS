// Production components and owned HTTP transport, with no business interception.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {WorkCaptureModesEditor} from '../../src/pages/WorkCaptureModesEditor';
import '../../src/index.css';
const Journey=()=>{
  const [view,setView]=useState('work');
  return <BrowserRouter><main className="mx-auto max-w-7xl p-5">
    <nav aria-label="Synthetic capture mode navigation"><button onClick={()=>setView('work')}>Enter work</button><button onClick={()=>setView('settings')}>Configure capture modes</button></nav>
    {view==='work'?<MyTimesheet/>:<WorkCaptureModesEditor/>}
  </main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Journey/>);
