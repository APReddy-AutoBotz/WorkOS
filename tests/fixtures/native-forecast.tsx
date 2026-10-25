// Synthetic navigation/session only. Actual Forecast page, editor and transport.
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {ForecastUtilization} from '../../src/pages/ForecastUtilization';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><main className="mx-auto max-w-7xl p-4"><ForecastUtilization/></main></BrowserRouter>);
