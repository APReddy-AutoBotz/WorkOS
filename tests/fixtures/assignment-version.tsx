import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AllocationControlPanel} from '../../src/pages/AllocationManagement';
import {AssignmentVersions} from '../../src/components/AssignmentVersions';
import {captureAssignmentContext} from '../../src/services/assignmentVersions';
import '../../src/index.css';
// Navigation only. The actual components, transport, API and PostgreSQL execute.
const Fixture=()=>{const[id]=useState(()=>new URLSearchParams(location.search).get('assignment'));return <BrowserRouter><main>{id?<AssignmentVersions assignmentId={id} onClose={()=>{}}/>:captureAssignmentContext('manage')?<AllocationControlPanel embedded/>:null}</main></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Fixture/>);
