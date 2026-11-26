// Synthetic navigation/session only; actual production pages and transport.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ResourceDemandPanel } from '../../src/components/ResourceDemandPanel';
import { AllocationControlPanel, type AllocationControlFocus } from '../../src/pages/AllocationManagement';
import { ApprovalsWorkspace } from '../../src/pages/ApprovalsWorkspace';
import { ESSHome } from '../../src/pages/LeaveManagement';
import { ForecastUtilization } from '../../src/pages/ForecastUtilization';
import { NotificationCenter } from '../../src/pages/NotificationCenter';
import { authService } from '../../src/services/authService';
import '../../src/index.css';
const Fixture = () => {
  const [view, setView] = useState(authService.getCurrentUser()?.role === 'Employee' ? 'own' : 'demand'), [focus, setFocus] = useState<AllocationControlFocus | null>(null);
  return <BrowserRouter><main className="mx-auto max-w-7xl p-4"><nav aria-label="Synthetic creation navigation"><button onClick={() => setView('demand')}>Creation staffing</button><button onClick={() => setView('approvals')}>Creation approvals</button><button onClick={() => setView('own')}>Creation own period</button><button onClick={() => setView('forecast')}>Creation forecast</button><button onClick={() => setView('notifications')}>Creation notifications</button></nav><div key={view}>{view === 'demand' ? <><ResourceDemandPanel onFocusAllocation={f => setFocus({ ...f, token: Date.now() })} /><AllocationControlPanel embedded focus={focus} onClearFocus={() => setFocus(null)} /></> : view === 'approvals' ? <ApprovalsWorkspace /> : view === 'own' ? <ESSHome /> : view === 'forecast' ? <ForecastUtilization /> : <NotificationCenter />}</div></main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Fixture />);
