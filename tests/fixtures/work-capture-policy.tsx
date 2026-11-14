// Actual production components and HTTP services. No business interception.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {WorkCapturePolicyEditor} from '../../src/pages/WorkCapturePolicyEditor';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import '../../src/index.css';
const Journey = () => {
  const [view, setView] = useState('work');
  return <BrowserRouter><main className="mx-auto max-w-7xl p-5">
    <nav aria-label="Synthetic capture acceptance navigation" className="flex gap-4">
      <button onClick={() => setView('work')}>Enter work</button>
      <button onClick={() => setView('policy')}>Configure capture policy</button>
    </nav>
    {view === 'work' ? <MyTimesheet /> : <WorkCapturePolicyEditor />}
  </main></BrowserRouter>;
};
createRoot(document.getElementById('root')!).render(<Journey />);
