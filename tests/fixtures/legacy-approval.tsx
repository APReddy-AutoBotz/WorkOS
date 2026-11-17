import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {ApprovalsWorkspace} from '../../src/pages/ApprovalsWorkspace';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><ApprovalsWorkspace/></BrowserRouter>);
