import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {DataStorage} from './services/storage';
import './index.css';

if (import.meta.env.MODE === 'test' && import.meta.env.VITE_ENABLE_TEST_FALLBACK === 'true') {
  DataStorage.initialize();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
