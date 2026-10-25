// Real production pages and API transport; only navigation/session fixtures are synthetic.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MyTimesheet } from '../../src/pages/MyTimesheet';
import { ApprovalsWorkspace } from '../../src/pages/ApprovalsWorkspace';
import { NotificationCenter } from '../../src/pages/NotificationCenter';
import '../../src/index.css';
import { authService } from '../../src/services/authService';
const Journey = () => { const [view, setView] = useState(authService.getCurrentUser()?.role === 'Employee' ? 'work' : 'approvals'); return <BrowserRouter><main className="mx-auto max-w-7xl p-5"><nav aria-label="Synthetic approval navigation"><button onClick={() => setView('work')}>Enter submitted work</button><button onClick={() => setView('approvals')}>Governed approvals</button><button onClick={() => setView('notifications')}>My notifications</button></nav><div key={view}>{view === 'work' ? <MyTimesheet /> : view === 'notifications' ? <NotificationCenter /> : <ApprovalsWorkspace />}</div></main></BrowserRouter>; };
createRoot(document.getElementById('root')!).render(<Journey />);
