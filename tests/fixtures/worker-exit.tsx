// Synthetic session only; the employee page, exit panel, API and database are real.
import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';
import {EmployeeMaster} from '../../src/pages/EmployeeMaster';import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><EmployeeMaster/></BrowserRouter>);
