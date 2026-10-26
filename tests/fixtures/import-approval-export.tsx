// Synthetic navigation/session only. All feature components and transports are real.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {WorkSubmissionHistory} from '../../src/components/WorkSubmissionHistory';
import {ImportExport} from '../../src/pages/ImportExport';
import {ApprovalsWorkspace} from '../../src/pages/ApprovalsWorkspace';
import {ActualUtilization} from '../../src/pages/ActualUtilization';
import {ESSHome} from '../../src/pages/LeaveManagement';
import {CanonicalApprovalInbox} from '../../src/components/GovernedWorkApprovals';
import '../../src/index.css';
const Fixture=()=>{const query=new URLSearchParams(window.location.search);const[view,setView]=useState('notices');return <BrowserRouter><main className="mx-auto max-w-7xl p-4"><nav aria-label="Synthetic imported work navigation"><button onClick={()=>setView('imports')}>Imported work intake</button><button onClick={()=>setView('approvals')}>Imported work approvals</button><button onClick={()=>setView('actual')}>Imported work actual</button><button onClick={()=>setView('own')}>Imported work own period</button><button onClick={()=>setView('notices')}>Imported work notices</button><button onClick={()=>setView('history')}>Imported work retained history</button></nav><div key={view}>{view==='imports'?<ImportExport/>:view==='approvals'?<ApprovalsWorkspace/>:view==='actual'?<ActualUtilization/>:view==='own'?<ESSHome/>:view==='history'?<WorkSubmissionHistory timesheetId={query.get('timesheetId')??''} expectedEmployeeId={query.get('employeeId')??undefined}/>:<CanonicalApprovalInbox/>}</div></main></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Fixture/>);
