// Synthetic navigation only; real product React, API and PostgreSQL remain authoritative.
import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route,Link} from 'react-router-dom';
import {CommercialDraftingWorkspace} from '../../src/pages/CommercialDraftingWorkspace';import {WorkforceDirectory} from '../../src/pages/WorkforceDirectory';import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><nav><Link to="/tests/fixtures/rate-candidates.html">Commercial</Link> · <Link to="/workforce/directory">Directory</Link></nav><Routes><Route path="/workforce/directory" element={<WorkforceDirectory/>}/><Route path="*" element={<CommercialDraftingWorkspace/>}/></Routes></BrowserRouter>);
