// Synthetic navigation/session only; all production pages and business calls are real.
import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route,Link}from'react-router-dom';
import{OwnWorkspace}from'../../src/pages/OwnWorkspace';import{MyTimesheet}from'../../src/pages/MyTimesheet';import{MyLeave,ESSHome}from'../../src/pages/LeaveManagement';import'../../src/index.css';
const Fixture=()=> <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic own workspace navigation"><Link to="/tests/fixtures/own-workspace.html">Canonical owned workspace</Link></nav><Routes><Route path="/timesheets" element={<MyTimesheet/>}/><Route path="/leave/my" element={<MyLeave/>}/><Route path="/ess" element={<ESSHome/>}/><Route path="*" element={<OwnWorkspace/>}/></Routes></main></BrowserRouter>;
createRoot(document.getElementById('root')!).render(<Fixture/>);
