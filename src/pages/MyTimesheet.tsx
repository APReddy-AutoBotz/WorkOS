import {canonicalHours,sumHours,compareHours} from '../../shared/work-hours.mjs';
import {hydrateWorkCaptureGrid,parseCaptureHourInput,canonicalCaptureHourInput,captureCalendarDate} from '../services/workCaptureGrid';
import type {TimesheetEntry} from '../types';
import {getOrganizationScope,getToken,ApiClientError,resetBackendCheck} from '../services/apiClient';
import { Fragment, useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { NoticeBanner } from '../components/ui/NoticeBanner';
import { cn } from '../lib/utils';
import { authService } from '../services/authService';
import { timesheetService, adminService, projectService, allocationService } from '../services/api';
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
const getWeekStart = (date: Date) => {
  const next = new Date(date);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  next.setHours(0, 0, 0, 0);
  return next;
};

const toIsoDate = captureCalendarDate;

const getWeekEnding = (weekStart: Date) => {
  const friday = new Date(weekStart);
  friday.setDate(friday.getDate() + 4);
  return toIsoDate(friday);
};

const startOfDay = (date: Date) => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const currentOwner = () => {
  const user = authService.getCurrentUser();
  const scope = getOrganizationScope();
  return JSON.stringify([user?.id, user?.role, getToken(), scope?.organizationId, scope?.legalEntityId]);
};

export const MyTimesheet = () => {
  const [currentWeek, setCurrentWeek] = useState(getWeekStart(new Date()));
  const owner = currentOwner();
  return <Fragment key={`${owner}:${toIsoDate(currentWeek)}`}><TimesheetEditor owner={owner} currentWeek={currentWeek} setCurrentWeek={setCurrentWeek} /></Fragment>;
};

const TimesheetEditor = ({owner, currentWeek, setCurrentWeek}: {
  owner: string; currentWeek: Date; setCurrentWeek: Dispatch<SetStateAction<Date>>;
}) => {
  const navigate = useNavigate();
  const user = authService.getCurrentUser();
  const currentWeekKey = toIsoDate(currentWeek);
  const currentUserId = user?.id;
  const today = startOfDay(new Date());
  const currentSystemWeek = getWeekStart(today);
  const isFutureWeek = currentWeek > currentSystemWeek;
  const [status, setStatus] = useState<'Draft' | 'Submitted' | 'Approved' | 'Rejected'>('Draft');

  const [workAssurance, setWorkAssurance] = useState<Assurance | undefined>();
  const [rows, setRows] = useState<any[]>([]);
  const [hourDrafts,setHourDrafts]=useState<Record<string,string>>({});
  const hasInvalidHours=rows.some(row=>row.hours.some((_,index)=>{
    const raw=hourDrafts[`${row.id}:${index}`];return raw!==undefined&&parseCaptureHourInput(raw)===null;
  }));
  const [preservedEntries,setPreservedEntries]=useState<TimesheetEntry[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [saving,setSaving]=useState(false);
  const savePending=useRef(false),generation=useRef(0),mounted=useRef(true);
  const ownsView=()=>mounted.current&&currentOwner()===owner;
  const [scopeRevision,setScopeRevision]=useState(0);
  useEffect(()=>{
    mounted.current=true;
    const changed=()=>{++generation.current;setLoaded(false);setRows([]);setPreservedEntries([]);setScopeRevision(value=>value+1);};
    window.addEventListener('workos:organization-scope-switch-requested',changed);
    window.addEventListener('workos:organization-scope-changed',changed);
    return()=>{mounted.current=false;++generation.current;window.removeEventListener('workos:organization-scope-switch-requested',changed);window.removeEventListener('workos:organization-scope-changed',changed);};
  },[]);
  const [assignedProjects, setAssignedProjects] = useState<any[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'warning' | 'danger'; message: string } | null>(null);

  const [rejectionNote, setRejectionNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!user) return;
    const request=++generation.current;let cancelled=false;
    setLoaded(false);setRows([]);setPreservedEntries([]);setHourDrafts({});setNotice(null);
    const weekEnding = getWeekEnding(currentWeek);
    Promise.all([
      projectService.getAll(),
      allocationService.getAll(),
      timesheetService.getAll(),
    ]).then(([projects, allocations, timesheets]) => {
      if(cancelled||request!==generation.current||!ownsView())return;
      const assigned = allocations
        .filter(a => {
          const project = projects.find(p => p.id === a.projectId);
          return a.employeeId === user.id &&
            a.status === 'Active' &&
            !!project &&
            isProjectAvailableForPlanning(project, currentWeekKey, weekEnding) &&
            overlapsDateRange(a.startDate, a.endDate, currentWeekKey, weekEnding);
        })
        .map(a => {
          const project = projects.find(p => p.id === a.projectId);
          return {
            id: a.projectId,
            name: a.projectName,
            client: project?.client || '',
            allocation: a.percentage,
          };
        });
      setAssignedProjects(assigned);
      const existing = timesheets.find(t => t.employeeId === user.id && t.weekEnding === weekEnding);
      if (existing) {
        const hydrated=hydrateWorkCaptureGrid(existing.entries,currentWeekKey);
        setRows(hydrated.rows);setPreservedEntries(hydrated.preservedEntries);
        setStatus(existing.status);
        setWorkAssurance(existing.workAssurance);
        setRejectionNote(existing.rejectionNote || existing.rejectionReason);
      } else {
        const firstProject = assigned[0];
        setRows(firstProject ? [
          {
            id: crypto.randomUUID(),
            workType: 'Project Work' as WorkType,
            category: '',
            clientName: '',
            projectId: firstProject.id,
            projectName: firstProject.name,
            hours: [0, 0, 0, 0, 0],
            remarks: ['', '', '', '', ''],
            rowRemark: '',
            billable: true
          }
        ] : []);
        setStatus('Draft');
        setWorkAssurance(undefined);
        setRejectionNote(undefined);
      }
      setLoaded(true);
    }).catch(()=>{if(!cancelled&&request===generation.current&&ownsView())setNotice({type:'danger',message:'Work could not be loaded. Reload before editing.'});});
    return()=>{cancelled=true;};
  }, [currentUserId, currentWeekKey,scopeRevision,user?.role]);

  const persistTimesheet = async (nextStatus: 'Draft' | 'Submitted') => {
    if (!user||!ownsView()||!loaded||savePending.current||hasInvalidHours||!['Draft','Rejected'].includes(status)) return;
    const owner=generation.current,scope=JSON.stringify(getOrganizationScope()),token=getToken();
    const current=()=>ownsView()&&owner===generation.current&&scope===JSON.stringify(getOrganizationScope())&&token===getToken();
    savePending.current=true;setSaving(true);
    try{
    const weekEnding = getWeekEnding(currentWeek);
    if (isFutureWeek) {
      setNotice({ type: 'warning', message: 'Future week timesheets cannot be saved or submitted.' });
      return;
    }
    let systemSettings;
    try{systemSettings=await adminService.getSettings();}catch{if(current())setNotice({type:'danger',message:'Submission settings could not be loaded. No save was sent.'});return;}
    if(!current())return;
    if (nextStatus === 'Submitted' && user.role === 'Admin' && !systemSettings.demoSubmissionMode) {
      setNotice({ type: 'warning', message: "Self-submission is disabled for Admins." });
      return;
    }

    const hasFutureHours = rows.some(row =>
      row.hours.some((h: number, i: number) => {
        const quantity=canonicalCaptureHourInput(hourDrafts[`${row.id}:${i}`]??row.exactHours?.[i]??String(h));
        if (quantity===null||compareHours(quantity,'0')<=0) return false;
        const entryDate = startOfDay(new Date(currentWeek));
        entryDate.setDate(entryDate.getDate() + i);
        return entryDate > today;
      })
    );

    if (nextStatus === 'Submitted' && hasFutureHours) {
      setNotice({
        type: 'warning',
        message: 'Submission blocked: timesheets cannot include hours for future dates. Save a draft or remove future-dated hours before submitting.',
      });
      return;
    }

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
        if (quantity!==null&&compareHours(quantity,'0')>0) {
          const d = new Date(currentWeek);
          d.setDate(d.getDate() + i);
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
            status: nextStatus,
            billable: row.billable,
            weekEnding
          });
        }
      });
    });

    if(!current())return;
    try {
      const assurance = await timesheetService.save({
        employeeId: user.id,
        employeeName: user.name,
        weekEnding,
        totalHours: Number(sumHours(entries.map(entry=>entry.hours))),
        billableHours: Number(sumHours(entries.filter(entry=>entry.billable).map(entry=>entry.hours))),
        status: nextStatus,
        submittedAt: nextStatus === 'Submitted' ? new Date().toISOString() : undefined,
        entries
      });
      if(!current())return;
      setStatus(nextStatus);
      setWorkAssurance(assurance);
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
    }finally{savePending.current=false;if(current())setSaving(false);}
  };

  const handleSubmit = () => {
    persistTimesheet('Submitted');
  };

  const handleSaveDraft = () => {
    persistTimesheet('Draft');
  };

  const [activeRemark, setActiveRemark] = useState<{rowId: string, dayIdx: number} | null>(null);

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const dates = days.map((_, i) => {
    const d = new Date(currentWeek);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  });

  const weekLabel = `${dates[0]} - ${dates[4]} ${currentWeek.getFullYear()}`;

  const updateHours = (rowId: string, dayIdx: number, val: string) => {
    if (status !== 'Draft' && status !== 'Rejected') return;
    setHourDrafts(previous=>({...previous,[`${rowId}:${dayIdx}`]:val}));
    const num = parseCaptureHourInput(val);
    if(num===null)return; // Invalid text stays visible and cannot be saved.
    setRows(rows.map(r => r.id === rowId ? {
      ...r,
      hours: r.hours.map((h: number, i: number) => i === dayIdx ? num : h)
    } : r));
  };

  const updateRemark = (rowId: string, dayIdx: number, val: string) => {
    if (status !== 'Draft' && status !== 'Rejected') return;
    setRows(rows.map(r => r.id === rowId ? {
      ...r,
      remarks: r.remarks.map((rm: string, i: number) => i === dayIdx ? val : rm)
    } : r));
  };

  const addRow = (type: WorkType = 'Project Work') => {
    if (status !== 'Draft' && status !== 'Rejected') return;
    const firstProject = assignedProjects[0];
    setRows([...rows, {
      id: Math.random().toString(),
      workType: type,
      category: '',
      clientName: '',
      projectId: type === 'Project Work' ? firstProject?.id || '' : undefined,
      projectName: type === 'Project Work' ? firstProject?.name || 'Select Assigned Project' : 'Client Support Activity',
      hours: [0, 0, 0, 0, 0],
      remarks: ['', '', '', '', ''],
      rowRemark: '',
      billable: true
    }]);
  };

  const removeRow = (id: string) => {
    if (status !== 'Draft' && status !== 'Rejected') return;
    setRows(rows.filter(r => r.id !== id));
  };

  const totalHours=Number(sumHours([...preservedEntries.map(entry=>entry.hours),...rows.flatMap(row=>row.hours)]));
  const projectHours=Number(sumHours([...preservedEntries.filter(entry=>entry.workType==='Project Work').map(entry=>entry.hours),...rows.filter(row=>row.workType==='Project Work').flatMap(row=>row.hours)]));
  const miscHours=Number(sumHours([...preservedEntries.filter(entry=>entry.workType==='Client Misc Task').map(entry=>entry.hours),...rows.filter(row=>row.workType==='Client Misc Task').flatMap(row=>row.hours)]));

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
      {loaded ? <WorkSubmissionAssurance assurance={workAssurance} status={status} /> : <p role="status">Loading current timesheet...</p>}
      <PageHeader
        title={user?.role === 'Admin' ? 'Admin Self-Log Test' : 'My Timesheet'}
        subtitle={headerSubtitle}
        breadcrumb={['Self Service', 'Timesheets']}
        actions={
          <div className="flex items-center gap-3">
             <div className="flex items-center bg-white border border-border-light rounded-xl p-1 shadow-sm mr-2">
                <button
                  aria-label="Previous week" onClick={() => setCurrentWeek(prev => {
                    const next = new Date(prev);
                    next.setDate(next.getDate() - 7);
                    return next;
                  })}
                  className="p-1.5 hover:bg-slate-50 rounded-lg transition-colors"
                ><ChevronLeft size={16} /></button>
                <div className="px-4 flex items-center gap-2">
                   <Calendar size={14} className="text-primary" />
                   <span className="text-[10px] font-bold uppercase tracking-widest text-heading">{weekLabel}</span>
                </div>
                 <button
                  onClick={() => setCurrentWeek(prev => {
                    const next = new Date(prev);
                    next.setDate(next.getDate() + 7);
                    return next;
                  })}
                  disabled={currentWeek >= currentSystemWeek}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors",
                    currentWeek >= currentSystemWeek
                      ? "text-slate-300 cursor-not-allowed"
                      : "hover:bg-slate-50"
                  )}
                  aria-label="Next week" title={currentWeek >= currentSystemWeek ? 'Future weeks are locked' : 'Next week'}
                ><ChevronRight size={16} /></button>
             </div>
             <button className="btn-secondary px-3 py-2" disabled={saving} onClick={()=>{resetBackendCheck();++generation.current;setLoaded(false);setScopeRevision(value=>value+1);}}>Reload work</button>
             {(status === 'Draft' || status === 'Rejected') ? (
               <>
                 <button
                    onClick={handleSaveDraft}
                    disabled={isFutureWeek||!loaded||saving||hasInvalidHours}
                    className="hidden sm:flex btn-secondary py-2.5 px-5 items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                 >
                    <Save size={14} /> Save Draft
                 </button>
                 <button
                  onClick={handleSubmit}
                  disabled={isFutureWeek||!loaded||saving||hasInvalidHours}
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

      <fieldset disabled={saving||!loaded||!['Draft','Rejected'].includes(status)} className="min-w-0">
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
              {rows.map((row) => (
                <tr key={row.id} className="group hover:bg-slate-50/30 transition-colors">
                  <td className="py-5 px-8">
                    <select
                      className="w-full bg-transparent text-[10px] font-bold text-slate-500 uppercase tracking-wider focus:outline-none cursor-pointer appearance-none"
                      value={row.workType}
                      onChange={(e) => {
                        const val = e.target.value as WorkType;
                        setRows(rows.map(r => r.id === row.id ? {
                          ...r,
                          workType: val,
                          projectId: val === 'Project Work' ? r.projectId : undefined,
                          projectName: val === 'Project Work' ? r.projectName : 'Select Category',
                          billable: val === 'Project Work'
                        } : r));
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
                              setRows(rows.map(r => r.id === row.id ? { ...r, projectId: e.target.value, projectName: p?.name || '' } : r));
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
                              onChange={(e) => setRows(rows.map(r => r.id === row.id ? { ...r, clientName: e.target.value } : r))}
                            />
                            <input
                              type="text"
                              placeholder="Misc Task (e.g. Call, Escalation)..."
                              className="w-full bg-transparent text-[10px] text-slate-400 font-medium outline-none"
                              value={row.category || ''}
                              onChange={(e) => setRows(rows.map(r => r.id === row.id ? { ...r, category: e.target.value } : r))}
                            />
                          </div>
                        )}
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-0.5">
                          {row.workType === 'Project Work' ? 'Client Engagement' : 'Client-Related Work'}
                        </p>
                      </div>
                      <button
                        onClick={() => removeRow(row.id)}
                        className="opacity-0 group-hover:opacity-100 p-2 text-gray-300 hover:text-danger transition-all"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                  {row.hours.map((hour, i) => (
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
                          onClick={() => setActiveRemark({rowId: row.id, dayIdx: i})}
                          className={cn(
                            "absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-all",
                            row.remarks[i] ? "text-primary opacity-100" : "text-slate-200 opacity-40 hover:opacity-100 hover:text-primary"
                          )}
                        >
                          <MessageSquare size={12} />
                        </button>
                      </div>
                    </td>
                  ))}
                  <td className="py-5 px-4 border-l border-gray-100">
                    <input
                      type="text"
                      placeholder="Overall activity notes..."
                      className="w-full bg-slate-50 border border-slate-100 rounded-lg py-2 px-3 text-[11px] font-medium text-heading placeholder:text-slate-300 outline-none focus:bg-white focus:border-primary/20 transition-all"
                      value={row.rowRemark || ''}
                      onChange={(e) => setRows(rows.map(r => r.id === row.id ? { ...r, rowRemark: e.target.value } : r))}
                    />
                  </td>
                  <td className="py-5 px-8 text-right font-mono font-bold text-primary bg-orange-50/10 border-l border-gray-100">
                    {sumHours(row.hours)}
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
                {days.map((_, i) => (
                  <td key={i} className="py-6 px-4 text-center text-heading border-l border-gray-100">
                    {sumHours(rows.map(row=>row.hours[i]))}
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
      {preservedEntries.length>0&&<section aria-label="Preserved off-grid entries" className="mt-4 rounded-xl border p-4"><p>{preservedEntries.length} existing entries are outside this compatibility grid or have zero hours. They are retained unchanged on save and included in totals.</p>{preservedEntries.map(entry=><p key={entry.id}>{entry.date}: {canonicalHours(entry.hours)}h, {entry.projectName||entry.clientName||entry.workType}, {entry.remark||'No comment'}</p>)}</section>}
      {!loaded&&<p role="status">Work is not ready for editing. Reload this page after checking connection and access.</p>}
      {saving&&<p role="status">Saving work…</p>}
      {/* Remark Input Modal/Overlay */}
      {activeRemark && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-border-light w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-4 bg-slate-50 border-b border-border-light flex justify-between items-center">
              <div>
                <h4 className="text-xs font-bold text-heading">Entry Remarks</h4>
                <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
                  {days[activeRemark.dayIdx]} • {rows.find(r => r.id === activeRemark.rowId)?.projectName}
                </p>
              </div>
              <button onClick={() => setActiveRemark(null)} className="p-1 hover:bg-white rounded-lg transition-colors">
                <X size={16} className="text-slate-400" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-[9px] font-bold text-rose-500 uppercase mb-2">Remarks mandatory for Client Misc Tasks</p>
              <textarea
                autoFocus
                className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm text-heading placeholder:text-slate-300 focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none shadow-inner"
                placeholder="Describe your work for this day in detail..."
                value={rows.find(r => r.id === activeRemark.rowId)?.remarks[activeRemark.dayIdx] || ''}
                onChange={(e) => updateRemark(activeRemark.rowId, activeRemark.dayIdx, e.target.value)}
              />
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
                    style={{ width: `${Math.min((projectHours / (totalHours || 1)) * 100, 100)}%` }}
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
