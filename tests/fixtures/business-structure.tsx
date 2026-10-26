// Synthetic navigation/session only; product UI, API and PostgreSQL remain real.
import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route,Link} from 'react-router-dom';
import {BusinessStructureWorkspace} from '../../src/pages/BusinessStructureWorkspace';
import {CalendarScopeAuthoringWorkspace} from '../../src/pages/CalendarScopeAuthoringWorkspace';
import {WorkforceDirectory} from '../../src/pages/WorkforceDirectory';import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><nav><Link to="/tests/fixtures/business-structure.html">Catalog authoring</Link> · <Link to="/admin/calendar-scope-authoring">Group calendars</Link> · <Link to="/workforce/directory">Directory</Link></nav><Routes><Route path="/admin/calendar-scope-authoring"element={<CalendarScopeAuthoringWorkspace/>}/><Route path="/workforce/directory"element={<WorkforceDirectory/>}/><Route path="*"element={<BusinessStructureWorkspace/>}/></Routes></BrowserRouter>);
