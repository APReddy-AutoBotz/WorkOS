import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {WorkerCapabilities} from '../../src/components/WorkerCapabilities';
import {CapabilityPlanner} from '../../src/components/CapabilityPlanner';
import '../../src/index.css';
const id=new URLSearchParams(location.search).get('worker')??'employee-commercial-owner';
createRoot(document.getElementById('root')!).render(<BrowserRouter><main><WorkerCapabilities key={id} employeeId={id}/><CapabilityPlanner/></main></BrowserRouter>);
