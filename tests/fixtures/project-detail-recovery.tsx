import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter, Routes, Route, useNavigate} from 'react-router-dom';
import {ProjectDetail} from '../../src/pages/ProjectDetail';
import {projectService, allocationService, employeeService, timesheetService, adminService, clientService} from '../../src/services/api';
import {authService} from '../../src/services/authService';
import {ApiClientError} from '../../src/services/apiClient';
import type {Project} from '../../src/types';
import '../../src/index.css';

const pending: Array<{id: string; resolve: (value: Project | undefined) => void; reject: (error: Error) => void}> = [];
const record = (id: string): Project => ({id, name:`Synthetic ${id}`, projectCode:id, client:'Example client', managerId:'synthetic-admin', managerName:'Synthetic administrator', startDate:'2026-01-01', endDate:'2026-12-31', status:'Active', billable:true, plannedUtilization:0, actualUtilization:0, resourceCount:0});
authService.getCurrentUser = () => ({id:'synthetic-admin', name:'Synthetic administrator', role:'Admin', permissions:['projects.manage']} as ReturnType<typeof authService.getCurrentUser>);
projectService.getById = id => new Promise((resolve,reject) => pending.push({id,resolve,reject}));
allocationService.getAll = async () => [];
employeeService.getAll = async () => [];
timesheetService.getAll = async () => [];
clientService.getAll = async () => [];
adminService.getSettings = async () => ({expectedWeeklyHours:40} as Awaited<ReturnType<typeof adminService.getSettings>>);
window.fetch = async () => { throw new Error('Unexpected fixture network request'); };
Object.assign(window, {projectDetailHarness:{
  pending: () => pending.map(item => item.id),
  settle: (id: string, outcome: 'found'|'missing'|'failed'|'denied') => {
    const index=pending.findIndex(item=>item.id===id);
    if(index<0) throw new Error('No pending project request');
    const [item]=pending.splice(index,1);
    if(outcome==='denied') item.reject(new ApiClientError('Synthetic private authorization detail',{status:403}));
    else if(outcome==='failed') item.reject(new Error('Synthetic private database detail'));
    else item.resolve(outcome==='found'?record(id):undefined);
  },
}});
const Journey=()=>{
  const navigate=useNavigate(); const [shown,setShown]=useState(true);
  return <><nav aria-label="Synthetic navigation">{['alpha','beta','gamma','missing'].map(id=><button key={id} onClick={()=>navigate('/projects/'+id)}>Open {id}</button>)}<button onClick={()=>navigate('/projects')}>Open no identifier</button><button onClick={()=>setShown(value=>!value)}>{shown?'Hide detail':'Show detail'}</button></nav>{shown&&<Routes><Route path="/projects/:id" element={<ProjectDetail/>}/><Route path="/projects" element={<ProjectDetail/>}/></Routes>}</>;
};
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/projects/alpha']}><Journey/></MemoryRouter>);
