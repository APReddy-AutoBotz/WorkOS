import {SubmissionDeadlinePreview} from '../components/SubmissionTiming';
import {WorkCaptureWarnings} from '../components/WorkCaptureWarnings';
import {WorkSubmissionHistory} from '../components/WorkSubmissionHistory';
import {workReferenceIsValid,normalizeWorkReference} from '../../shared/work-reference.mjs';
import {evidenceUrlIsValid,normalizeEvidenceUrl} from '../../shared/work-evidence.mjs';
import {canonicalHours,sumHours,compareHours} from '../../shared/work-hours.mjs';
import {hydrateWorkCaptureGrid,parseCaptureHourInput,canonicalCaptureHourInput,captureUtcDate,captureHeaderMonday,captureCellText,captureCellHours,captureCellPresent,setCaptureRowHours,patchVisibleCaptureRow,removeVisibleCaptureRow} from '../services/workCaptureGrid';
import type {TimesheetEntry,DuplicateEntryCheck,OvertimeWarning} from '../types';
import {ApiClientError,resetBackendCheck} from '../services/apiClient';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { NoticeBanner } from '../components/ui/NoticeBanner';
import { cn } from '../lib/utils';
import { authService } from '../services/authService';
import {captureWorkCaptureContext,isWorkCaptureContextCurrent,workCaptureWorkspaceService,type WorkCaptureContext,type CaptureMode,type CaptureModesProjection} from '../services/workCaptureModes';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Plus,
  Save,
  Send,
  Trash2,
  Clock,
  Briefcase,
  AlertCircle,
  Target,
  MessageSquare,
  X,
  XCircle,
  ShieldCheck
} from 'lucide-react';
import { WorkType, WorkSubmissionAssurance as Assurance } from '../types';
import { WorkSubmissionAssurance } from '../components/WorkSubmissionAssurance';
import { isProjectAvailableForPlanning, overlapsDateRange } from '../services/calculations';

import { productConfig } from '../config/productConfig';
const toIsoDate=captureUtcDate;
const shiftDate=(date:Date,days:number)=>{const next=new Date(date);next.setUTCDate(next.getUTCDate()+days);return next;};
// Preserve the existing Friday header identity. Saturday/Sunday belong to the
// following Friday's rolling seven-day header, not a new daily approval unit.
const getWeekStart=(date:Date)=>new Date(`${captureHeaderMonday(toIsoDate(date))}T00:00:00Z`);
const getWeekEnding=(weekStart:Date)=>toIsoDate(shiftDate(weekStart,4));
const allDays=['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];
const WorkReference=({value}:{value?:string|null})=>value?<span className="block text-xs text-body break-words">Reference: {value}</span>:null;
const EvidenceLink=({value}:{value?:string|null})=>{
  if(!value)return null;
  if(!evidenceUrlIsValid(value))return <span>Invalid evidence URL</span>;
  return <a href={normalizeEvidenceUrl(value)!} target="_blank" rel="noopener noreferrer" className="text-primary underline text-xs">Open evidence</a>;
};

export const MyTimesheet = () => {
  const navigate = useNavigate();
  const user = authService.getCurrentUser();
  const [currentWeek, setCurrentWeek] = useState(getWeekStart(new Date()));
  const currentWeekKey = toIsoDate(currentWeek);
  const currentUserId = user?.id;
  const [serverDate,setServerDate]=useState(new Date().toISOString().slice(0,10));
  const today=new Date(`${serverDate}T00:00:00Z`);
  const currentSystemWeek = getWeekStart(today);
  const gridStart=toIsoDate(shiftDate(currentWeek,-2));
  const [modes,setModes]=useState<CaptureModesProjection|null>(null);
  const [mode,setMode]=useState<CaptureMode|null>(null),[dailyIndex,setDailyIndex]=useState(2);
  const [writeToken,setWriteToken]=useState<string|null>(null);
  const [loadedOwner,setLoadedOwner]=useState<WorkCaptureContext|null>(null);
  const loadedContext=useRef<WorkCaptureContext|null>(null),blocked=useRef(false),aligned=useRef(false);
  const visibleIndices=mode==='daily'?[dailyIndex]:[2,3,4,5,6];
  const isFutureWeek = currentWeek > currentSystemWeek;
  const [status, setStatus] = useState<'Draft' | 'Submitted' | 'Approved' | 'Rejected'>('Draft');

  const [captureWarnings,setCaptureWarnings]=useState<OvertimeWarning[]|undefined>();
  const [historyHeader,setHistoryHeader]=useState<string|undefined>();
  const [duplicateEntryCheck,setDuplicateEntryCheck]=useState<DuplicateEntryCheck|undefined>();
  const [workAssurance, setWorkAssurance] = useState<Assurance | undefined>();
  const [rows, setRows] = useState<any[]>([]);
  const [hourDrafts,setHourDrafts]=useState<Record<string,string>>({});
  const hasInvalidHours=rows.some(row=>row.hours.some((_,index)=>{
    const raw=hourDrafts[`${row.id}:${index}`];return raw!==undefined&&parseCaptureHourInput(raw)===null;
  }));
  const hasInvalidReference=rows.some(row=>row.workReferences?.some(value=>!workReferenceIsValid(value)));
  const hasInvalidEvidence=rows.some(row=>row.evidenceUrls?.some(value=>!evidenceUrlIsValid(value)));
  const [preservedEntries,setPreservedEntries]=useState<TimesheetEntry[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [saving,setSaving]=useState(false);
  const savePending=useRef(false),generation=useRef(0);
  const [scopeRevision,setScopeRevision]=useState(0);
  const blockWork=()=>{
    blocked.current=true;++generation.current;loadedContext.current=null;savePending.current=false;
    setLoaded(false);setLoadedOwner(null);setSaving(false);setRows([]);setHourDrafts({});setPreservedEntries([]);setActiveRemark(null);
    setStatus('Draft');setWorkAssurance(undefined);setDuplicateEntryCheck(undefined);setHistoryHeader(undefined);setCaptureWarnings(undefined);setRejectionNote(undefined);setAssignedProjects([]);setModes(null);setMode(null);setWriteToken(null);
    setNotice({type:'warning',message:'Access or scope changed. Reload work explicitly for the selected legal entity.'});
  };
  useEffect(()=>{
    const changed=()=>blockWork();
    const check=()=>{if(loadedContext.current&&!isWorkCaptureContextCurrent(loadedContext.current))blockWork();};
    window.addEventListener('workos:organization-scope-switch-requested',changed);
    window.addEventListener('workos:organization-scope-changed',changed);window.addEventListener('storage',check);window.addEventListener('focus',check);
    return()=>{++generation.current;window.removeEventListener('workos:organization-scope-switch-requested',changed);window.removeEventListener('workos:organization-scope-changed',changed);window.removeEventListener('storage',check);window.removeEventListener('focus',check);};
  },[]);
  const [assignedProjects, setAssignedProjects] = useState<any[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'warning' | 'danger'; message: string } | null>(null);

  const [rejectionNote, setRejectionNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    if(!user||blocked.current)return;
    const request=++generation.current;let cancelled=false;
    const context=captureWorkCaptureContext(()=>!cancelled&&request===generation.current);
    setLoaded(false);setLoadedOwner(null);loadedContext.current=null;setRows([]);setPreservedEntries([]);setHourDrafts({});setNotice(null);setActiveRemark(null);
    setStatus('Draft');setWorkAssurance(undefined);setDuplicateEntryCheck(undefined);setHistoryHeader(undefined);setCaptureWarnings(undefined);setRejectionNote(undefined);setAssignedProjects([]);setModes(null);setMode(null);setWriteToken(null);
    workCaptureWorkspaceService.get(context).then(({projects,allocations,timesheets,modes:projection})=>{
      if(cancelled||request!==generation.current)return;
      if(!context||!isWorkCaptureContextCurrent(context)){blockWork();return;}
      setServerDate(projection.serverDate);
      if(!aligned.current){
        aligned.current=true;const system=getWeekStart(new Date(`${projection.serverDate}T00:00:00Z`));
        if(toIsoDate(system)!==currentWeekKey){setCurrentWeek(system);return;}
      }
      const weekEnding=getWeekEnding(currentWeek);
      const assigned=allocations.filter(a=>{
        const project=projects.find(p=>p.id===a.projectId);
        return a.employeeId===user.id&&a.status==='Active'&&project&&isProjectAvailableForPlanning(project,gridStart,weekEnding)
          &&overlapsDateRange(a.startDate,a.endDate,gridStart,weekEnding);
      }).map(a=>({id:a.projectId,name:a.projectName,client:projects.find(p=>p.id===a.projectId)?.client||'',allocation:a.percentage}));
      setAssignedProjects(assigned);setModes(projection);setMode(previous=>previous&&projection.enabledModes.includes(previous)?previous:projection.enabledModes[0]||null);
      setDailyIndex(Math.max(0,Math.min(6,Math.floor((Date.parse(projection.serverDate+'T00:00:00Z')-Date.parse(gridStart+'T00:00:00Z'))/86400000))));
      const existing=timesheets.find(t=>t.employeeId===user.id&&t.weekEnding===weekEnding);
      if(existing){
        const hydrated=hydrateWorkCaptureGrid(existing.entries,gridStart,7);setRows(hydrated.rows);setPreservedEntries(hydrated.preservedEntries);
        setStatus(existing.status);setWriteToken(existing.writeToken!);setWorkAssurance(existing.workAssurance);setDuplicateEntryCheck(existing.duplicateEntryCheck);setHistoryHeader(existing.id);setCaptureWarnings(existing.captureWarnings);setRejectionNote(existing.rejectionNote||existing.rejectionReason);
      }else{
        const first=assigned[0];setRows(first?[{id:crypto.randomUUID(),workType:'Project Work',category:'',clientName:'',projectId:first.id,projectName:first.name,
          hours:Array(7).fill(0),exactHours:Array(7).fill('0'),remarks:Array(7).fill(''),evidenceUrls:Array(7).fill(null),workReferences:Array(7).fill(null),rowRemark:'',billable:true}]:[]);
        setStatus('Draft');setWriteToken(null);setWorkAssurance(undefined);setDuplicateEntryCheck(undefined);setHistoryHeader(undefined);setCaptureWarnings(undefined);setRejectionNote(undefined);
      }
      loadedContext.current=context;setLoadedOwner(context);setLoaded(true);
    }).catch(()=>{if(!cancelled&&request===generation.current)setNotice({type:'danger',message:'Work could not be loaded. Reload before editing.'});});
    return()=>{cancelled=true;};
  },[currentUserId,currentWeekKey,scopeRevision,user?.role]);
  const editable=()=>loaded&&!saving&&!savePending.current&&['Draft','Rejected'].includes(status)&&Boolean(mode&&loadedOwner&&isWorkCaptureContextCurrent(loadedOwner));
  const patchRow=(rowId:string,patch:Record<string,unknown>)=>{
    if(!editable())return;const next=patchVisibleCaptureRow(rows,hourDrafts,rowId,visibleIndices,patch,crypto.randomUUID());setRows(next.rows);setHourDrafts(next.drafts);
  };

  const changeWeek=(days:number)=>{
    if(!loaded||saving||savePending.current||!loadedOwner||!isWorkCaptureContextCurrent(loadedOwner))return;
    ++generation.current;loadedContext.current=null;setLoaded(false);setLoadedOwner(null);setActiveRemark(null);
    setStatus('Draft');setWorkAssurance(undefined);setDuplicateEntryCheck(undefined);setHistoryHeader(undefined);setCaptureWarnings(undefined);setRejectionNote(undefined);setAssignedProjects([]);setModes(null);setMode(null);setWriteToken(null);
    setCurrentWeek(previous=>shiftDate(previous,days));
  };

  const persistTimesheet = async (nextStatus: 'Draft' | 'Submitted') => {
    if (!user||!editable()||hasInvalidHours||hasInvalidEvidence||hasInvalidReference||!mode||!loadedOwner) return;
    const owner=generation.current,context=loadedOwner;
    const current=()=>owner===generation.current&&isWorkCaptureContextCurrent(context);
    savePending.current=true;setSaving(true);setActiveRemark(null);
    try{
    const weekEnding = getWeekEnding(currentWeek);
    if (isFutureWeek||(nextStatus==='Submitted'&&weekEnding>serverDate)) {
      setNotice({ type: 'warning', message: 'Future week timesheets cannot be saved or submitted.' });
      return;
    }
    let systemSettings;
    try{systemSettings=await workCaptureWorkspaceService.submissionSettings(context);}catch{if(current())setNotice({type:'danger',message:'Submission settings could not be loaded. No save was sent.'});return;}
    if(!current())return;
    if (nextStatus === 'Submitted' && user.role === 'Admin' && !systemSettings.demoSubmissionMode) {
      setNotice({ type: 'warning', message: "Self-submission is disabled for Admins." });
      return;
    }

    const hasFutureHours=rows.some(row=>row.hours.some((_:number,index:number)=>
      compareHours(captureCellHours(row,index,hourDrafts),'0')>0&&toIsoDate(shiftDate(currentWeek,index-2))>serverDate))
      ||preservedEntries.some(entry=>entry.date>serverDate);
    if(hasFutureHours){setNotice({type:'warning',message:'Future-dated work cannot be saved or submitted.'});return;}

    // Validation: Client Misc Task requires remarks
    const missingRemarks = rows.some(row =>
      row.workType === 'Client Misc Task' &&
      row.hours.some((h: number, i: number) => {const quantity=canonicalCaptureHourInput(hourDrafts[`${row.id}:${i}`]??row.exactHours?.[i]??String(h));return quantity!==null&&compareHours(quantity,'0')>0&&!row.remarks[i];})
    );

    if (nextStatus === 'Submitted' && missingRemarks) {
      setNotice({
        type: 'danger',
        message: "Submission blocked: remarks are mandatory for all 'Client Misc Task' entries with hours.",
      });
      return;
    }

    // Flatten rows to entries
    const entries: any[] = preservedEntries.map(entry=>({...entry,hours:entry.hoursExact??entry.hours,status:nextStatus}));
    rows.forEach(row => {
      row.hours.forEach((h: number, i: number) => {
        const quantity=canonicalCaptureHourInput(hourDrafts[`${row.id}:${i}`]??row.exactHours?.[i]??String(h));
        if (quantity!==null&&(compareHours(quantity,'0')>0||Boolean(row.evidenceUrls?.[i])||Boolean(row.workReferences?.[i]))) {
          const d = shiftDate(currentWeek,i-2);
          entries.push({
            id: Math.random().toString(),
            employeeId: user.id,
            projectId: row.projectId,
            projectName: row.projectName,
            workType: row.workType,
            clientName: row.clientName,
            category: row.category,
            date: toIsoDate(d),
            hours: quantity,
            remark: row.remarks[i],
            evidenceUrl: normalizeEvidenceUrl(row.evidenceUrls?.[i]??null),
            workReference: normalizeWorkReference(row.workReferences?.[i]??null),
            status: nextStatus,
            billable: row.billable,
            weekEnding
          });
        }
      });
    });

    if(!current())return;
    try {
      const saved=await workCaptureWorkspaceService.save({employeeId:user.id,weekEnding,status:nextStatus,entries},
        {writeToken,mode,modePolicyId:modes?.latestId||null},context);
      if(!current())return;
      setWriteToken(saved.writeToken);setStatus(nextStatus);setWorkAssurance(saved.workAssurance);setDuplicateEntryCheck(saved.duplicateEntryCheck);setHistoryHeader(saved.timesheetId);setCaptureWarnings(saved.captureWarnings);
      setRejectionNote(undefined);
      setNotice({
        type: 'success',
        message: nextStatus === 'Submitted' ? 'Timesheet submitted for review.' : 'Draft timesheet saved.',
      });
    } catch (error) {
      if(!current())return;
      const rejected=error instanceof ApiClientError&&[400,422].includes(error.status);
      if(!rejected)setLoaded(false);
      setNotice({
        type: 'danger',
        message: (error instanceof Error ? error.message : 'Timesheet could not be saved.')+(rejected?'':' Reload work before trying again.'),
      });
    }
    }finally{if(owner===generation.current){savePending.current=false;setSaving(false);}}
  };

  const handleSubmit = () => {
    persistTimesheet('Submitted');
  };

  const handleSaveDraft = () => {
    persistTimesheet('Draft');
  };

  const [activeRemark, setActiveRemark] = useState<{rowId: string, dayIdx: number} | null>(null);

  const days=visibleIndices.map(index=>allDays[index]);
  const dates=visibleIndices.map(index=>shiftDate(currentWeek,index-2).toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}));
  const weekLabel=`${toIsoDate(shiftDate(currentWeek,-2))} - ${getWeekEnding(currentWeek)}`;
  const visibleRows=rows.filter(row=>visibleIndices.some(index=>captureCellPresent(row,index,hourDrafts))||!row.hours.some((_:number,index:number)=>captureCellPresent(row,index,hourDrafts)));
  const hiddenCells=rows.flatMap(row=>row.hours.map((_:number,index:number)=>({row,index})).filter(({index})=>!visibleIndices.includes(index)&&captureCellPresent(row,index,hourDrafts)));

  const updateHours = (rowId: string, dayIdx: number, val: string) => {
    if (!editable()) return;
    setHourDrafts(previous=>({...previous,[`${rowId}:${dayIdx}`]:val}));
    const num = parseCaptureHourInput(val);
    if(num===null)return; // Invalid text stays visible and cannot be saved.
    setRows(rows.map(row=>row.id===rowId?setCaptureRowHours(row,dayIdx,val):row));
  };

  const updateReference=(rowId:string,dayIdx:number,value:string)=>{
    if(!editable())return;
    setRows(rows.map(row=>row.id===rowId?{...row,workReferences:row.hours.map((_:number,index:number)=>index===dayIdx?value:row.workReferences?.[index]??null)}:row));
  };
  const updateEvidence = (rowId:string,dayIdx:number,value:string)=>{
    if(!editable())return;
    setRows(rows.map(row=>row.id===rowId?{...row,evidenceUrls:row.hours.map((_:number,index:number)=>index===dayIdx?value:row.evidenceUrls?.[index]??null)}:row));
  };

  const updateRemark = (rowId: string, dayIdx: number, val: string) => {
    if (!editable()) return;
    setRows(rows.map(r => r.id === rowId ? {
      ...r,
      remarks: r.remarks.map((rm: string, i: number) => i === dayIdx ? val : rm)
    } : r));
  };

  const addRow = (type: WorkType = 'Project Work') => {
    if (!editable()) return;
    const firstProject = assignedProjects[0];
    setRows([...rows, {
      id: Math.random().toString(),
      workType: type,
      category: '',
      clientName: '',
      projectId: type === 'Project Work' ? firstProject?.id || '' : undefined,
      projectName: type === 'Project Work' ? firstProject?.name || 'Select Assigned Project' : 'Client Support Activity',
      hours: Array(7).fill(0), exactHours:Array(7).fill('0'),
      remarks: Array(7).fill(''), evidenceUrls:Array(7).fill(null),workReferences:Array(7).fill(null),
      rowRemark: '',
      billable: true
    }]);
  };

  const removeRow = (id: string) => {
    if (!editable()) return;
    const next=removeVisibleCaptureRow(rows,hourDrafts,id,visibleIndices);setRows(next.rows);setHourDrafts(next.drafts);
  };

  const rowTotal=(row:any)=>sumHours(row.hours.map((_:number,index:number)=>captureCellHours(row,index,hourDrafts)));
  const totalHours=sumHours([...preservedEntries.map(entry=>entry.hoursExact??entry.hours),...rows.map(rowTotal)]);
  const projectHours=sumHours([...preservedEntries.filter(entry=>entry.workType==='Project Work').map(entry=>entry.hoursExact??entry.hours),...rows.filter(row=>row.workType==='Project Work').map(rowTotal)]);
  const miscHours=sumHours([...preservedEntries.filter(entry=>entry.workType==='Client Misc Task').map(entry=>entry.hoursExact??entry.hours),...rows.filter(row=>row.workType==='Client Misc Task').map(rowTotal)]);

  const workTypes: WorkType[] = [
    'Project Work',
    'Client Misc Task'
  ];

  const headerSubtitle = user?.role === 'Admin'
    ? "Testing view for project-level effort entries. Audit restricted to demo scenarios."
    : `Log your client/project-related effort. Internal ${productConfig.organizationName} activities should not be submitted here.`;

  if (user?.role === 'CountryDirector') {
    return <Navigate to="/timesheets/approval" replace />;
  }

  return (
    <div className="animate-in fade-in duration-500 pb-12">
      <WorkCaptureWarnings warnings={captureWarnings}/>
      {loaded&&!saving&&!['Submitted','Approved'].includes(status)&&<SubmissionDeadlinePreview dates={[getWeekEnding(currentWeek),...preservedEntries.map(entry=>entry.date),...rows.flatMap(row=>row.hours.flatMap((_,index)=>captureCellPresent(row,index,hourDrafts)?[toIsoDate(shiftDate(currentWeek,index-2))]:[]))]}/>}
      <WorkSubmissionAssurance assurance={workAssurance} status={status} entryCheck={duplicateEntryCheck} />
      {loaded&&historyHeader&&!saving&&<div key={`${historyHeader}:${writeToken}`}><WorkSubmissionHistory timesheetId={historyHeader}/></div>}
      <PageHeader
        title={user?.role === 'Admin' ? 'Admin Self-Log Test' : 'My Timesheet'}
        subtitle={headerSubtitle}
        breadcrumb={['Self Service', 'Timesheets']}
        actions={
          <div className="flex items-center gap-3">
             <div className="flex items-center bg-white border border-border-light rounded-xl p-1 shadow-sm mr-2">
                <button
                  aria-label="Previous week" disabled={saving||!loaded} onClick={() => changeWeek(-7)}
                  className="p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
                ><ChevronLeft size={16} /></button>
                <div className="px-4 flex items-center gap-2">
                   <Calendar size={14} className="text-primary" />
                   <span className="text-[10px] font-bold uppercase tracking-widest text-heading">{weekLabel}</span>
                </div>
                 <button
                  onClick={() => changeWeek(7)}
                  disabled={currentWeek >= currentSystemWeek||saving||!loaded}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors",
                    currentWeek >= currentSystemWeek
                      ? "text-slate-300 cursor-not-allowed"
                      : "hover:bg-slate-50"
                  )}
                  aria-label="Next week" title={currentWeek >= currentSystemWeek ? 'Future weeks are locked' : 'Next week'}
                ><ChevronRight size={16} /></button>
             </div>
             <button className="btn-secondary px-3 py-2" disabled={saving} onClick={()=>{resetBackendCheck();blocked.current=false;++generation.current;setLoaded(false);setLoadedOwner(null);setActiveRemark(null);setScopeRevision(value=>value+1);}}>Reload work</button>
             {(status === 'Draft' || status === 'Rejected') ? (
               <>
                 <button
                    onClick={handleSaveDraft}
                    disabled={isFutureWeek||!editable()||hasInvalidHours||hasInvalidEvidence||hasInvalidReference}
                    className="hidden sm:flex btn-secondary py-2.5 px-5 items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                 >
                    <Save size={14} /> Save Draft
                 </button>
                 <button
                  onClick={handleSubmit}
                  disabled={isFutureWeek||getWeekEnding(currentWeek)>serverDate||!editable()||hasInvalidHours||hasInvalidEvidence||hasInvalidReference}
                  className="btn-primary py-2.5 px-5 flex items-center gap-2 shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                 >
                    <Send size={14} /> Submit for Approval
                 </button>
               </>
             ) : (
               <Badge variant={status === 'Approved' ? 'success' : 'neutral'} className="py-2.5 px-5">
                 {status === 'Submitted' ? 'Awaiting Review' : status}
               </Badge>
             )}
          </div>
        }
      />

      {notice && (
        <NoticeBanner
          type={notice.type}
          title="Timesheet"
          message={notice.message}
          onClose={() => setNotice(null)}
          className="mt-6"
        />
      )}

      {status === 'Rejected' && rejectionNote && (
        <div className="mt-8 bg-rose-50 border border-rose-100 rounded-2xl p-6 animate-in slide-in-from-top-4 duration-300">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-white border border-rose-100 flex items-center justify-center text-rose-500 shrink-0">
              <XCircle size={20} />
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-bold text-rose-900">Timesheet Sent Back for Correction</h4>
              <p className="text-xs text-rose-700 mt-1 font-medium italic">"{rejectionNote}"</p>
              <p className="text-[10px] text-rose-500 font-bold uppercase tracking-widest mt-2">Action Required: Revise the entries and resubmit for approval.</p>
            </div>
          </div>
        </div>
      )}

      <section aria-label="Capture presentation" className="my-4 flex flex-wrap items-center gap-4">
        <label>Capture mode <select aria-label="Capture mode" disabled={!loaded||saving||!loadedOwner||!isWorkCaptureContextCurrent(loadedOwner)} value={mode||''} onChange={event=>{if(!loadedOwner||!isWorkCaptureContextCurrent(loadedOwner)||saving)return;setActiveRemark(null);setMode(event.target.value as CaptureMode);}}>
          {!mode&&<option value="">Not configured</option>}{modes?.enabledModes.map(value=><option key={value} value={value}>{value==='weekly'?'Weekly grid':'Daily entry'}</option>)}
        </select></label>
        {mode==='daily'&&<label>Work date <select aria-label="Work date" disabled={!loaded||saving||!loadedOwner||!isWorkCaptureContextCurrent(loadedOwner)} value={dailyIndex} onChange={event=>{if(!loadedOwner||!isWorkCaptureContextCurrent(loadedOwner)||saving)return;setActiveRemark(null);setDailyIndex(Number(event.target.value));}}>{allDays.map((day,index)=><option key={day} value={index}>{day} {toIsoDate(shiftDate(currentWeek,index-2))}</option>)}</select></label>}
        <p>Daily and weekly views share one whole-header submission and approval. Submitted headers cannot end after {serverDate} (UTC).</p>
        {loaded&&!mode&&<p role="status">No capture modes enabled. Ask an authorized administrator to configure modes explicitly.</p>}
      </section>
      <fieldset disabled={!editable()} className="min-w-0">
      <div className="mt-8 bg-white border border-border-light rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 border-b border-border-light">
              <tr>
                <th className="py-5 px-8 text-[10px] font-bold text-gray-400 uppercase tracking-widest min-w-[120px]">Work Type</th>
                <th className="py-5 px-8 text-[10px] font-bold text-gray-400 uppercase tracking-widest min-w-[280px]">Assignment / Client Context</th>
                {days.map((day, i) => (
                  <th key={day} className="py-5 px-4 text-[10px] font-bold text-center uppercase tracking-widest border-l border-gray-100">
                    <div className="text-gray-400">{day}</div>
                    <div className="text-heading mt-1">{dates[i]}</div>
                  </th>
                ))}
                <th className="py-5 px-8 text-[10px] font-bold text-gray-400 uppercase tracking-widest min-w-[200px] border-l border-gray-100">Notes / Remarks</th>
                <th className="py-5 px-8 text-[10px] font-bold text-right uppercase tracking-widest border-l border-gray-100 bg-orange-50/30 text-primary">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light">
              {visibleRows.map((row) => (
                <tr key={row.id} className="group hover:bg-slate-50/30 transition-colors">
                  <td className="py-5 px-8">
                    <select
                      className="w-full bg-transparent text-[10px] font-bold text-slate-500 uppercase tracking-wider focus:outline-none cursor-pointer appearance-none"
                      value={row.workType}
                      onChange={(e) => {
                        const val = e.target.value as WorkType;
                        patchRow(row.id,{workType:val,projectId:val==='Project Work'?row.projectId:undefined,
                          projectName:val==='Project Work'?row.projectName:'Select Category',billable:val==='Project Work'});
                      }}
                    >
                      {workTypes.map(wt => <option key={wt} value={wt}>{wt}</option>)}
                    </select>
                  </td>
                  <td className="py-5 px-8">
                    <div className="flex items-center gap-4">
                      <div className={cn(
                        "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border",
                        row.workType === 'Project Work' ? "bg-orange-50 border-primary/10 text-primary" : "bg-slate-50 border-slate-200 text-slate-400"
                      )}>
                        {row.workType === 'Project Work' ? <Briefcase size={16} /> : <Target size={16} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        {row.workType === 'Project Work' ? (
                          <select
                            className="w-full bg-transparent text-sm font-bold text-heading focus:outline-none cursor-pointer appearance-none"
                            value={row.projectId}
                            onChange={(e) => {
                              const p = assignedProjects.find(pr => pr.id === e.target.value);
                              patchRow(row.id,{projectId:e.target.value,projectName:p?.name||''});
                            }}
                          >
                            <option value="">{row.projectName}</option>
                            {assignedProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        ) : (
                          <div className="space-y-1">
                            <input
                              type="text"
                              placeholder="Client Name..."
                              className="w-full bg-transparent text-sm font-bold text-heading outline-none"
                              value={(row as any).clientName || ''}
                              onChange={(e) => patchRow(row.id,{clientName:e.target.value})}
                            />
                            <input
                              type="text"
                              placeholder="Misc Task (e.g. Call, Escalation)..."
                              className="w-full bg-transparent text-[10px] text-slate-400 font-medium outline-none"
                              value={row.category || ''}
                              onChange={(e) => patchRow(row.id,{category:e.target.value})}
                            />
                          </div>
                        )}
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-0.5">
                          {row.workType === 'Project Work' ? 'Client Engagement' : 'Client-Related Work'}
                        </p>
                      </div>
                      <button
                        aria-label="Remove visible entry" onClick={() => removeRow(row.id)}
                        className="opacity-0 group-hover:opacity-100 p-2 text-gray-300 hover:text-danger transition-all"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                  {visibleIndices.map(i => {const hour=row.hours[i];return (
                    <td key={i} className="py-5 px-4 border-l border-gray-100 relative group/cell">
                      <div className="relative">
                        <input
                          type="text"
                          value={hourDrafts[`${row.id}:${i}`]??(row.exactHours?.[i]&&row.exactHours[i]!=='0'?row.exactHours[i]:hour === 0 ? '' : String(hour))}
                          aria-invalid={parseCaptureHourInput(hourDrafts[`${row.id}:${i}`]??row.exactHours?.[i]??String(hour))===null}
                          placeholder="0.0"
                          onChange={(e) => updateHours(row.id, i, e.target.value)}
                          className={cn(
                            "w-full bg-white border border-slate-200 rounded-lg py-3 text-center text-sm font-bold text-heading focus:ring-2 focus:ring-primary/20 outline-none transition-all shadow-sm pr-6",
                            row.remarks[i] && "border-primary/30",
                            (row.workType === 'Client Misc Task' && hour > 0 && !row.remarks[i]) && "border-rose-300 ring-rose-100"
                          )}
                        />
                        <button
                          aria-label={`Edit ${allDays[i]} remark`} onClick={() => {if(editable())setActiveRemark({rowId: row.id, dayIdx: i});}}
                          className={cn(
                            "absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-all",
                            row.remarks[i] ? "text-primary opacity-100" : "text-slate-200 opacity-40 hover:opacity-100 hover:text-primary"
                          )}
                        >
                          <MessageSquare size={12} />
                        </button>
                      </div>
                      <WorkReference value={row.workReferences?.[i]}/><EvidenceLink value={row.evidenceUrls?.[i]}/>
                    </td>
                  );})}
                  <td className="py-5 px-4 border-l border-gray-100">
                    <input
                      type="text"
                      placeholder="Overall activity notes..."
                      className="w-full bg-slate-50 border border-slate-100 rounded-lg py-2 px-3 text-[11px] font-medium text-heading placeholder:text-slate-300 outline-none focus:bg-white focus:border-primary/20 transition-all"
                      value={row.rowRemark || ''}
                      onChange={(e) => patchRow(row.id,{rowRemark:e.target.value})}
                    />
                  </td>
                  <td className="py-5 px-8 text-right font-mono font-bold text-primary bg-orange-50/10 border-l border-gray-100">
                    {rowTotal(row)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 border-t-2 border-border-light font-bold">
              <tr>
                <td colSpan={2} className="py-6 px-8 flex items-center gap-4">
                  <button
                    onClick={() => addRow('Project Work')}
                    className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-primary hover:text-orange-600 transition-colors"
                  >
                    <Plus size={14} /> Add Project Entry
                  </button>
                  <button
                    onClick={() => addRow('Client Misc Task')}
                    className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-blue-600 hover:text-blue-700 transition-colors"
                  >
                    <Plus size={14} /> Add Client Misc Task
                  </button>
                </td>
                {visibleIndices.map(i => (
                  <td key={i} className="py-6 px-4 text-center text-heading border-l border-gray-100">
                    {sumHours(rows.map(row=>captureCellHours(row,i,hourDrafts)))}
                  </td>
                ))}
                <td className="py-6 px-8 border-l border-gray-100 bg-slate-50/50"></td>
                <td className="py-6 px-8 text-right text-xl text-primary border-l border-gray-100 bg-orange-50/30">
                  {canonicalHours(totalHours)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      </fieldset>
      {hasInvalidHours&&<p role="alert">Correct invalid hours before saving. Use a decimal quantity from 0 to 24; invalid values have not changed the work totals.</p>}
      {hasInvalidReference&&<p role="alert">Use a single-line work reference of at most 200 characters without control characters.</p>}
      {hasInvalidEvidence&&<p role="alert">Use an absolute HTTP or HTTPS evidence URL of at most 2048 characters without embedded credentials.</p>}
      {preservedEntries.length>0&&<section aria-label="Preserved off-grid entries" className="mt-4 rounded-xl border p-4"><p>{preservedEntries.length} existing entries are outside this compatibility grid or have zero hours. They are retained unchanged on save and included in totals.</p>{preservedEntries.map(entry=><p key={entry.id}>{entry.date}: {canonicalHours(entry.hoursExact??entry.hours)}h, {entry.projectName||entry.clientName||entry.workType}, {entry.remark||'No comment'} <WorkReference value={entry.workReference}/><EvidenceLink value={entry.evidenceUrl}/></p>)}</section>}
      {hiddenCells.length>0&&<section aria-label="Preserved unseen entries" className="mt-4 rounded-xl border p-4"><p>These cells are outside the current view and remain in the same whole-header save. Change their context only in a view that includes their dates.</p>{hiddenCells.map(({row,index})=><p key={`${row.id}:${index}`}>{toIsoDate(shiftDate(currentWeek,index-2))}: {captureCellText(row,index,hourDrafts)}h, {row.projectName||row.clientName||row.workType}, {row.category||'No category'}, {row.remarks[index]||'No comment'} <WorkReference value={row.workReferences?.[index]}/><EvidenceLink value={row.evidenceUrls?.[index]}/></p>)}</section>}
      {!loaded&&<p role="status">Work is not ready for editing. Reload this page after checking connection and access.</p>}
      {saving&&<p role="status">Saving work…</p>}
      {/* Remark Input Modal/Overlay */}
      {activeRemark && (
        <div role="dialog" aria-label="Entry remarks" aria-modal="true" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-border-light w-full max-w-sm max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200">
            <div className="p-4 bg-slate-50 border-b border-border-light flex justify-between items-center">
              <div>
                <h4 className="text-xs font-bold text-heading">Entry Remarks</h4>
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
                  {allDays[activeRemark.dayIdx]} • {rows.find(r => r.id === activeRemark.rowId)?.projectName}
                </p>
              </div>
              <button aria-label="Close entry remarks" onClick={() => setActiveRemark(null)} className="p-1 hover:bg-white rounded-lg transition-colors">
                <X size={16} className="text-slate-400" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-[9px] font-bold text-rose-500 uppercase mb-2">Remarks mandatory for Client Misc Tasks</p>
              <textarea
                autoFocus disabled={!editable()}
                className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm text-heading placeholder:text-slate-300 focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none shadow-inner"
                placeholder="Describe your work for this day in detail..."
                value={rows.find(r => r.id === activeRemark.rowId)?.remarks[activeRemark.dayIdx] || ''}
                onChange={(e) => updateRemark(activeRemark.rowId, activeRemark.dayIdx, e.target.value)}
              />
              <label className="block mt-3 text-sm">Task / ticket / milestone reference (optional)
                <input type="text" maxLength={400} disabled={!editable()} placeholder="Task ID, ticket ID or milestone label"
                  className="w-full border rounded-lg p-2 mt-1 text-sm"
                  value={rows.find(row=>row.id===activeRemark.rowId)?.workReferences?.[activeRemark.dayIdx]??''}
                  aria-invalid={!workReferenceIsValid(rows.find(row=>row.id===activeRemark.rowId)?.workReferences?.[activeRemark.dayIdx]??null)}
                  onChange={event=>updateReference(activeRemark.rowId,activeRemark.dayIdx,event.target.value)}/>
              </label>
              <p className="text-xs mt-1">Up to 200 characters. An empty reference clears it.</p>
              <label className="block mt-3 text-sm">Evidence URL (optional)
                <input type="url" maxLength={2048} disabled={!editable()} placeholder="https://example.test/work-reference"
                  className="w-full border rounded-lg p-2 mt-1 text-sm"
                  value={rows.find(row=>row.id===activeRemark.rowId)?.evidenceUrls?.[activeRemark.dayIdx]??''}
                  aria-invalid={!evidenceUrlIsValid(rows.find(row=>row.id===activeRemark.rowId)?.evidenceUrls?.[activeRemark.dayIdx]??null)}
                  onChange={event=>updateEvidence(activeRemark.rowId,activeRemark.dayIdx,event.target.value)}/>
              </label>
              <p className="text-xs mt-1">An empty URL clears this entry's link. The link is stored without a preview.</p>
              <button
                onClick={() => setActiveRemark(null)}
                className="w-full mt-4 btn-primary py-3 text-xs font-bold shadow-lg shadow-primary/20"
              >
                Save Daily Remark
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-4 gap-6">
         <div className="bg-white border border-border-light rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
               <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-dark">
                  <Clock size={20} />
               </div>
               <h4 className="text-sm font-bold tracking-tight">Total Client Hours</h4>
            </div>
            <div className="flex items-end gap-2">
               <span className="text-3xl font-black text-heading leading-none tabular-nums">{canonicalHours(totalHours)}</span>
               <span className="text-xs font-bold text-gray-400 mb-1">HOURS</span>
            </div>
            <div className="mt-4 space-y-2">
               <div className="flex justify-between items-end">
                  <p className="text-xs text-body">Project Hours</p>
                  <p className="text-xs font-bold text-primary">{canonicalHours(projectHours)}h</p>
               </div>
               <div className="flex justify-between items-end">
                  <p className="text-xs text-body">Client Misc Hours</p>
                  <p className="text-xs font-bold text-blue-600">{canonicalHours(miscHours)}h</p>
               </div>
               <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.min((Number(projectHours) / (Number(totalHours) || 1)) * 100, 100)}%` }}
                  />
               </div>
            </div>
         </div>

         <div className="lg:col-span-2 bg-slate-dark text-white rounded-2xl p-6 shadow-sm flex flex-col justify-between">
            <div className="flex justify-between items-start">
               <div className="flex items-center gap-3">
                  <AlertCircle size={18} className="text-primary" />
                  <h4 className="text-sm font-bold tracking-tight">System Guidance</h4>
               </div>
               <Badge variant="neutral" className="border-white/20 bg-white/10 text-white">Server capture policy</Badge>
            </div>
            <p className="text-xs text-white/50 mt-4 leading-relaxed font-medium">{`
               Log only client/project-related effort. Internal ${productConfig.organizationName} activities should not be submitted here.
               Effective capture increments, all-work daily/Weekly limits and required comments are validated by the server. Client Misc Task remarks remain required by this grid.
               Every timesheet is reviewed directly by your ${productConfig.terminology.regionalOwner} for actual utilization reporting.
            `}</p>
         </div>

         <div className="bg-white border border-border-light rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
               <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-dark">
                  <ShieldCheck size={20} />
               </div>
               <h4 className="text-sm font-bold tracking-tight">Approval Status</h4>
            </div>
            <div className="space-y-4">
               <div>
                  <Badge variant="neutral">Draft Status</Badge>
                  <p className="text-[10px] text-slate-400 font-bold uppercase mt-2">Week Ending: {getWeekEnding(currentWeek)}</p>
               </div>
               <div className="pt-4 border-t border-slate-50">
                  <p className="text-xs font-bold text-heading">{`Reviewer: ${productConfig.terminology.regionalOwner}`}</p>
                  <p className="text-[10px] text-slate-400 font-medium">Approved hours directly affect actual utilization.</p>
               </div>
            </div>
         </div>
      </div>
    </div>
  );
};
