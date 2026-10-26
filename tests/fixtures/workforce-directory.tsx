// Synthetic session/navigation only. Product React, API and database are real.
import {createRoot} from 'react-dom/client';
import {WorkforceDirectory} from '../../src/pages/WorkforceDirectory';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-7xl p-5"><WorkforceDirectory/></main>);
