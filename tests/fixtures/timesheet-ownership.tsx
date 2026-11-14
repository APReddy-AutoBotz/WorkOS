// Controlled timing fixture: real MyTimesheet, synthetic service promises.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {MyTimesheet} from '../../src/pages/MyTimesheet';
import {authService} from '../../src/services/authService';
import {timesheetService, projectService, allocationService, adminService} from '../../src/services/api';
import '../../src/index.css';
let identity = 'synthetic-worker-a';
const reads: Array<{resolve: (value: any) => void; identity: string}> = [];
const saves: Array<{resolve: (value: any) => void; input: any}> = [];
const settings: Array<(value: any) => void> = [];
let holdSettings = false;
const assurance = (sequence: number) => ({submissionId:`synthetic-submission-${sequence}`,sequence,policyVersion:'assignment-work-date/1',entryCount:1,governedEntryCount:1});
authService.getCurrentUser = () => ({id:identity,name:'Synthetic worker',role:'Employee',permissions:['timesheets.submit']} as any);
projectService.getAll = async () => [];
allocationService.getAll = async () => [];
adminService.getSettings = () => holdSettings ? new Promise(resolve=>settings.push(resolve)) : Promise.resolve({demoSubmissionMode:true} as any);
timesheetService.getAll = () => new Promise(resolve => reads.push({resolve,identity}));
timesheetService.save = input => new Promise(resolve => saves.push({resolve,input}));
(window as any).ownership = {
  reads, saves, settings,
  holdSettings() {holdSettings=true;},
  releaseSettings(index: number) {holdSettings=false;settings[index]({demoSubmissionMode:true});},
  releaseRead(index: number, sequence: number) {
    const request=reads[index];
    const monday=new Date();monday.setDate(monday.getDate()+((monday.getDay()+6)%7)*-1);monday.setHours(0,0,0,0);
    request.resolve(Array.from({length:12},(_,i)=>{const day=new Date(monday);day.setDate(day.getDate()+4-i*7);return {id:`synthetic-week-${i}`,employeeId:request.identity,weekEnding:[day.getFullYear(),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0')].join('-'),entries:[],status:'Draft',workAssurance:assurance(sequence)};}));
  },
  releaseSave(index: number, sequence: number) {saves[index].resolve(assurance(sequence));},
};
const Fixture=()=>{const [revision,setRevision]=useState(0);return <BrowserRouter><button onClick={()=>{identity=identity==='synthetic-worker-a'?'synthetic-worker-b':'synthetic-worker-a';setRevision(revision+1);}}>Replace identity</button><MyTimesheet /></BrowserRouter>;};
createRoot(document.getElementById('root')!).render(<Fixture />);
