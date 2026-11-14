import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {ResourcePlanningSignals} from '../../src/pages/PlanningWorkspace';
import {ProjectManagerWorkspace} from '../../src/pages/ProjectManagerWorkspace';
import {planningService, projectService, allocationService, employeeService, timesheetService, adminService} from '../../src/services/api';
import {authService} from '../../src/services/authService';
import {ApiClientError} from '../../src/services/apiClient';
import '../../src/index.css';
type Kind='planning'|'pm';
const pending: Array<{kind:Kind;resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
const counts={planning:0,pm:0};
const defer=(kind:Kind)=>{counts[kind]++;return new Promise<any>((resolve,reject)=>pending.push({kind,resolve,reject}));};
// Match the real session reader: every call returns a newly parsed object.
authService.getCurrentUser=()=>JSON.parse('{"id":"synthetic-manager","employeeId":"synthetic-worker","name":"Synthetic manager","role":"ProjectManager","permissions":[]}');
planningService.getResourcePlanning=()=>defer('planning');
projectService.getAll=()=>defer('pm');
allocationService.getAll=async()=>[];employeeService.getAll=async()=>[];timesheetService.getAll=async()=>[];
adminService.getSettings=async()=>({utilizationThresholdHigh:100,utilizationThresholdLow:80,timesheetPolicyMaxHours:40,expectedWeeklyHours:40,benchThreshold:20,currency:'USD'});
window.fetch=async()=>{throw new Error('Unexpected fixture network request');};
Object.assign(window,{planningRecoveryHarness:{counts:()=>({...counts}),pending:()=>pending.map(item=>item.kind),settle:(kind:Kind,outcome:'failed'|'denied'|'empty'|'populated')=>{
 const index=pending.findIndex(item=>item.kind===kind);if(index<0)throw new Error('No pending read');const [item]=pending.splice(index,1);
 if(outcome==='failed')item.reject(new Error('Synthetic private database diagnostic'));
 else if(outcome==='denied')item.reject(new ApiClientError('Synthetic private permission diagnostic',{status:403}));
 else if(kind==='pm') item.resolve(outcome==='populated'?['synthetic-manager','other-manager'].map(managerId=>({id:managerId,projectCode:managerId,name:managerId==='synthetic-manager'?'Synthetic managed project':'Synthetic other project',client:'Example client',managerId,managerName:managerId,startDate:'2026-01-01',endDate:'2026-12-31',status:'Active',billable:true,plannedUtilization:0,actualUtilization:0,resourceCount:0})):[]);
 else item.resolve({generatedAt:'2026-11-14T00:00:00Z',asOfDate:'2026-11-14',summary:{people:outcome==='populated'?7:0,averagePlanned:0,averageAvailabilityAdjustedCapacity:0,benchCount:0,overloadedCount:0,underloadedCount:0,rollOffSoonCount:0},rows:[]});
}}});
const Journey=()=>{const [kind,setKind]=useState<Kind>('planning');const [shown,setShown]=useState(true);return <MemoryRouter><nav aria-label="Synthetic navigation"><button onClick={()=>setKind('planning')}>Open planning</button><button onClick={()=>setKind('pm')}>Open PM</button><button onClick={()=>setShown(value=>!value)}>{shown?'Hide workspace':'Show workspace'}</button></nav>{shown&&(kind==='planning'?<ResourcePlanningSignals/>:<ProjectManagerWorkspace/>)}</MemoryRouter>;};
createRoot(document.getElementById('root')!).render(<Journey/>);
