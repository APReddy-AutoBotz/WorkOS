import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {NotificationCenter} from '../../src/pages/NotificationCenter';
import '../../src/index.css';
// Synthetic session/mount only; production page, transport and API remain real.
createRoot(document.getElementById('root')!).render(<BrowserRouter><NotificationCenter/></BrowserRouter>);
