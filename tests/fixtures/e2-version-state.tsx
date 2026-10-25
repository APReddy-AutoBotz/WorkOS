// Synthetic navigation/session only; all feature pages and transports are real.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApprovalsWorkspace } from '../../src/pages/ApprovalsWorkspace';
import { ESSHome } from '../../src/pages/LeaveManagement';
import { ActualUtilization } from '../../src/pages/ActualUtilization';
import { ForecastUtilization } from '../../src/pages/ForecastUtilization';
import { NotificationCenter } from '../../src/pages/NotificationCenter';
import { authService } from '../../src/services/authService';
import '../../src/index.css';

const Fixture = () => {
  const [view, setView] = useState(authService.getCurrentUser()?.role === 'Employee' ? 'notifications' : 'approvals');
  return <BrowserRouter><main className="mx-auto max-w-7xl p-4">
    <nav aria-label="Synthetic E2 navigation">
      <button onClick={() => setView('approvals')}>E2 approvals</button>
      <button onClick={() => setView('own')}>E2 own period</button>
      <button onClick={() => setView('actual')}>E2 actual report</button>
      <button onClick={() => setView('native')}>E2 native forecast</button>
      <button onClick={() => setView('notifications')}>E2 notifications</button>
    </nav>
    <div key={view}>{view === 'approvals' ? <ApprovalsWorkspace /> : view === 'own' ? <ESSHome /> : view === 'actual' ? <ActualUtilization /> : view === 'native' ? <ForecastUtilization /> : <NotificationCenter />}</div>
  </main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Fixture />);
