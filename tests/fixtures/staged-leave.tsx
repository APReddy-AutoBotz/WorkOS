// Synthetic navigation/session only. All feature pages and HTTP/SQL paths are real.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApprovalsWorkspace } from '../../src/pages/ApprovalsWorkspace';
import { MyLeave, TeamLeaveCalendar, ESSHome } from '../../src/pages/LeaveManagement';
import { ActualUtilization } from '../../src/pages/ActualUtilization';
import { authService } from '../../src/services/authService';
import '../../src/index.css';
const Fixture = () => {
  const [view, setView] = useState(authService.getCurrentUser()?.role === 'Employee' ? 'leave' : 'approvals');
  return <BrowserRouter><main className="mx-auto max-w-7xl p-4"><nav aria-label="Synthetic staged leave navigation">
    <button onClick={() => setView('approvals')}>Staged work approvals</button>
    <button onClick={() => setView('leave')}>My calendar leave</button>
    <button onClick={() => setView('team')}>Review calendar leave</button>
    <button onClick={() => setView('own')}>Own capacity and actual</button>
    <button onClick={() => setView('actual')}>Actual report and exports</button>
  </nav><div key={view}>{view === 'approvals' ? <ApprovalsWorkspace /> : view === 'leave' ? <MyLeave /> : view === 'team' ? <TeamLeaveCalendar /> : view === 'own' ? <ESSHome /> : <ActualUtilization />}</div></main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Fixture />);
