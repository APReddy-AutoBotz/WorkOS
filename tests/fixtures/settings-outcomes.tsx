import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AdminSettings} from '../../src/pages/AdminSettings';
import '../../src/index.css';
const Journey=()=>{const [shown,setShown]=useState(true);return <BrowserRouter><button onClick={()=>setShown(value=>!value)}>{shown?'Hide settings':'Show settings'}</button>{shown&&<AdminSettings/>}</BrowserRouter>};
createRoot(document.getElementById('root')!).render(<Journey/>);
