import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route,Link} from 'react-router-dom';
import {ESSHome} from '../../src/pages/LeaveManagement';
import {EmployeeWorkspace} from '../../src/pages/EmployeeWorkspace';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import '../../src/index.css';
// Synthetic navigation/session only; production pages, transport, API and DB.
const Fixture=()=> <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic own period navigation"><Link to="/tests/fixtures/own-work-planning.html?canonical=1">My workspace</Link><Link to="/my-workspace">Compatibility work workspace</Link></nav><Routes><Route path="/timesheets" element={<MyTimesheet/>}/><Route path="/my-workspace" element={<div data-testid="compatibility-workspace"><EmployeeWorkspace/></div>}/><Route path="*" element={<div data-testid="canonical-ess"><ESSHome/></div>}/></Routes></main></BrowserRouter>;
createRoot(document.getElementById('root')!).render(<Fixture/>);
