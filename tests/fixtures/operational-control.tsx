// Synthetic session/navigation only; actual production workspace and API transport.
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {OperationalControlWorkspace} from '../../src/pages/OperationalControlWorkspace';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><OperationalControlWorkspace/></BrowserRouter>);
