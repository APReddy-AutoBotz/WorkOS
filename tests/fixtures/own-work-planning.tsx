import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route,Link} from 'react-router-dom';
import {EmployeeWorkspace} from '../../src/pages/EmployeeWorkspace';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import '../../src/index.css';
// Synthetic navigation/session only; production pages, transport, API and DB.
const Fixture=()=> <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic own period navigation"><Link to="/tests/fixtures/own-work-planning.html">My workspace</Link></nav><Routes><Route path="/timesheets" element={<MyTimesheet/>}/><Route path="*" element={<EmployeeWorkspace/>}/></Routes></main></BrowserRouter>;
createRoot(document.getElementById('root')!).render(<Fixture/>);
