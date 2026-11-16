import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {TeamLeaveCalendar} from '../../src/pages/LeaveManagement';
import '../../src/index.css';
// Synthetic mounting only; the page, transport, API and PostgreSQL are real.
createRoot(document.getElementById('root')!).render(<BrowserRouter><main className="mx-auto max-w-7xl p-5"><TeamLeaveCalendar/></main></BrowserRouter>);
