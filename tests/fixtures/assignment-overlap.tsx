import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AllocationControlPanel} from '../../src/pages/AllocationManagement';
import {ImportExport} from '../../src/pages/ImportExport';
import '../../src/index.css';
// Navigation only; production components/transport/API/database perform work.
const Fixture=()=>{const[view,setView]=useState('plan');return <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic assignment policy navigation"><button onClick={()=>setView('plan')}>Plan percentage assignments</button><button onClick={()=>setView('import')}>Import percentage assignments</button></nav><div key={view}>{view==='plan'?<AllocationControlPanel embedded/>:<ImportExport/>}</div></main></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Fixture/>);
