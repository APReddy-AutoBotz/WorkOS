import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {TimesheetApproval} from '../../src/pages/TimesheetApproval';
import '../../src/index.css';
// Synthetic mounting only; production page, transport, API and database are real.
createRoot(document.getElementById('root')!).render(<BrowserRouter><TimesheetApproval/></BrowserRouter>);
