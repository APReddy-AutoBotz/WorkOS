import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CanonicalApprovalInbox } from '../../src/components/GovernedWorkApprovals';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <CanonicalApprovalInbox />
  </BrowserRouter>,
);
