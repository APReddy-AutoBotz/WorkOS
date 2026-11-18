// Controlled timing fixture: real MyTimesheet, synthetic service promises.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {authService} from '../../src/services/authService';
import {workCaptureWorkspaceService} from '../../src/services/workCaptureModes';
import {workCategoryService} from '../../src/services/workCategories';
import {shiftCapacityDate} from '../../shared/worker-capacity.mjs';
import '../../src/index.css';
let identity = 'synthetic-worker-a';
const reads: Array<{resolve: (value: any) => void; identity: string}> = [];
const saves: Array<{resolve: (value: any) => void; input: any}> = [];
const settings: Array<(value: any) => void> = [];
let holdSettings = false;
const assurance = (sequence: number) => ({submissionId:`synthetic-submission-${sequence}`,sequence,policyVersion:'assignment-work-date/1',entryCount:1,governedEntryCount:1});
authService.getCurrentUser = () => ({id:identity,name:'Synthetic worker',role:'Employee',permissions:['timesheets.submit']} as any);
const scope={organizationId:'synthetic-org',legalEntityId:'synthetic-legal'};
sessionStorage.setItem('workos_organization_scope',JSON.stringify(scope));
workCaptureWorkspaceService.submissionSettings = () => holdSettings ? new Promise(resolve=>settings.push(resolve)) : Promise.resolve({demoSubmissionMode:true} as any);
workCategoryService.options = async (startsOn, endsOn) => {
  const days = [];
  for (let date = startsOn; date <= endsOn; date = shiftCapacityDate(date, 1)) {
    days.push({date, catalogId: null, sequence: 0, effectiveFrom: null, enabled: false, categories: []});
  }
  return days;
};
workCaptureWorkspaceService.get = () => new Promise(resolve => reads.push({resolve,identity}));
workCaptureWorkspaceService.save = input => new Promise(resolve => saves.push({resolve,input}));
(window as any).ownership = {
  reads, saves, settings,
  holdSettings() {holdSettings=true;},
  releaseSettings(index: number) {holdSettings=false;settings[index]({demoSubmissionMode:true});},
  releaseRead(index: number, sequence: number) {
    const request=reads[index];
    const monday=new Date();monday.setUTCDate(monday.getUTCDate()+((monday.getUTCDay()+6)%7)*-1);monday.setUTCHours(0,0,0,0);
    request.resolve({projects:[],allocations:[],modes:{...scope,serverDate:new Date().toISOString().slice(0,10),latestId:'synthetic-mode-policy',enabledModes:['weekly','daily']},timesheets:Array.from({length:12},(_,i)=>{const day=new Date(monday);day.setUTCDate(day.getUTCDate()+4-i*7);return {id:`synthetic-week-${i}`,employeeId:request.identity,weekEnding:day.toISOString().slice(0,10),writeToken:crypto.randomUUID(),entries:[],status:'Draft',workAssurance:assurance(sequence)};})});
  },
  releaseSave(index: number, sequence: number) {saves[index].resolve({writeToken:crypto.randomUUID(),workAssurance:assurance(sequence)});},
};
const Fixture=()=>{const [revision,setRevision]=useState(0);return <BrowserRouter><button onClick={()=>{identity=identity==='synthetic-worker-a'?'synthetic-worker-b':'synthetic-worker-a';setRevision(revision+1);}}>Replace identity</button><MyTimesheet /></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Fixture />);
