type Deadline = {stage:number; dueAt:string; observedAt:string; overdue:boolean};

export function StageDeadline({deadline}:{deadline?:Deadline}) {
  if (!deadline) return null;
  return <p>Stage {deadline.stage+1} due <time dateTime={deadline.dueAt}>{deadline.dueAt}</time>
    {deadline.overdue ? ' · Overdue' : ''} · Checked <time dateTime={deadline.observedAt}>{deadline.observedAt}</time></p>;
}

type StageTimingInputProps = {
  value: string;
  onChange: (value: string) => void;
  reminderLead: string;
  onReminderChange: (value: string) => void;
};

export function StageDurationInput({value,onChange,reminderLead,onReminderChange}:StageTimingInputProps) {
  return <>
    <label>Time allowed per stage (minutes, optional)
      <input type="number" min="1" max="2147483647" step="1" value={value} onChange={e=>{onChange(e.target.value); if (Number(e.target.value)<=1) onReminderChange('');}}/>
    </label>
    <label>Remind approvers before the deadline (minutes, optional)
      <input type="number" min="1" max={Number(value)-1} step="1" disabled={Number(value)<=1}
        value={reminderLead} onChange={e=>onReminderChange(e.target.value)}/>
    </label>
  </>;
}

export function OverdueDeliveryHistory({rows}:{rows?:{stage:number;dueAt:string;attempts:number;status:string}[]}) {
  if (!rows?.length) return null;
  return <section aria-label="Overdue delivery history"><h4>Overdue delivery history</h4>{rows.map(r=>
    <p key={r.stage}>Stage {r.stage+1} due <time dateTime={r.dueAt}>{r.dueAt}</time> · {r.status==='RecipientUnavailable' ? 'Recipient unavailable. Delivery will retry.' : r.status==='TemplateUnavailable' ? 'Overdue message unavailable. Delivery will retry.' : r.status} · Attempts {r.attempts}</p>
  )}</section>;
}

export function OverdueMessageFields({enabled,subject,body,setSubject,setBody}:{
  enabled:boolean; subject:string; body:string; setSubject:(s:string)=>void; setBody:(s:string)=>void
}) {
  if (!enabled) return null;
  return <fieldset><legend>Overdue notification</legend>
    <p>Enter a title and body to use the policy locale, or leave both empty to use the standard English message.</p>
    <label>Overdue notification title<input maxLength={200} value={subject} onChange={e=>setSubject(e.target.value)}/></label>
    <label>Overdue notification body<textarea maxLength={8000} value={body} onChange={e=>setBody(e.target.value)}/></label>
  </fieldset>;
}
