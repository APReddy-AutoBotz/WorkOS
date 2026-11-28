type Deadline = {stage:number; dueAt:string; observedAt:string; overdue:boolean};

export function StageDeadline({deadline}:{deadline?:Deadline}) {
  if (!deadline) return null;
  return <p>Stage {deadline.stage+1} due <time dateTime={deadline.dueAt}>{deadline.dueAt}</time>
    {deadline.overdue ? ' · Overdue' : ''} · Checked <time dateTime={deadline.observedAt}>{deadline.observedAt}</time></p>;
}

export function StageDurationInput({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  return <label>Time allowed per stage (minutes, optional)
    <input type="number" min="1" max="2147483647" step="1" value={value} onChange={e=>onChange(e.target.value)}/>
  </label>;
}
