// Synthetic navigation/session only; real production pages, transport and API/SQL.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyLeave,TeamLeaveCalendar,ESSHome} from '../../src/pages/LeaveManagement';
import {ActualUtilization} from '../../src/pages/ActualUtilization';
import '../../src/index.css';
const Fixture=()=>{const[view,setView]=useState('leave');return <BrowserRouter><main className="mx-auto max-w-7xl p-4"><nav><button onClick={()=>setView('leave')}>My calendar leave</button><button onClick={()=>setView('team')}>Review calendar leave</button><button onClick={()=>setView('own')}>My effective period</button><button onClick={()=>setView('actual')}>Governed actual report</button></nav><div key={view}>{view==='leave'?<MyLeave/>:view==='team'?<TeamLeaveCalendar/>:view==='own'?<ESSHome/>:<ActualUtilization/>}</div></main></BrowserRouter>;};createRoot(document.getElementById('root')!).render(<Fixture/>);
