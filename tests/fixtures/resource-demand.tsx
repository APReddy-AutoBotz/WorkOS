import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {ResourceDemandPanel} from '../../src/components/ResourceDemandPanel';
import {AllocationControlPanel,type AllocationControlFocus} from '../../src/pages/AllocationManagement';
import {captureDemandContext} from '../../src/services/resourceDemand';
import '../../src/index.css';
const Fixture=()=>{const[focus,setFocus]=useState<AllocationControlFocus|null>(null);return <BrowserRouter><main><ResourceDemandPanel onFocusAllocation={f=>setFocus({...f,token:Date.now()})}/>{captureDemandContext('manage')&&<AllocationControlPanel embedded focus={focus} onClearFocus={()=>setFocus(null)}/>}</main></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Fixture/>);
