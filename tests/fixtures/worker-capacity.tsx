import {createRoot} from 'react-dom/client';
import {WorkerCapacity} from '../../src/components/WorkerCapacity';
import {ResourceDemandPanel} from '../../src/components/ResourceDemandPanel';
import '../../src/index.css';
// Synthetic navigation only; production components, transport and API rules.
createRoot(document.getElementById('root')!).render(<main><WorkerCapacity employeeId="employee-commercial-owner"/><ResourceDemandPanel onFocusAllocation={()=>{}}/></main>);
