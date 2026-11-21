import {hasRatePermission} from '../services/rateCandidates';
import {useState} from 'react';
import {commercialDraftingService, isCommercialDraftingContextCurrent, type CommercialDraftingContext, type ContractTerms} from '../services/commercialDrafting';

const read= commercialDraftingService.retainerStatement;
type Result=Awaited<ReturnType<typeof read>>;
export function RetainerStatement({contractId,version,startsOn,context}:{
  contractId:string;version:ContractTerms;startsOn:string;context:CommercialDraftingContext;
}) {
  const [current,setCurrent]=useState<Result>(),[archived,setArchived]=useState<Result>();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[reason,setReason]=useState('');
  const canPrepare=context.canManage && hasRatePermission('commercial.retainer_statements.prepare');
  const canDecide=hasRatePermission('commercial.retainer_statements.decide');
  async function load(action?:Parameters<typeof read>[4]) {
    if (busy || !isCommercialDraftingContextCurrent(context)) return;
    setBusy(true);setMessage('');setArchived(undefined);
    try {
      const result=await read(contractId,version,startsOn,context,action,!canPrepare);
      if (!isCommercialDraftingContextCurrent(context)) return;
      if (action && 'decision' in action) {setCurrent(undefined);setReason('');setMessage('Statement '+action.decision.toLowerCase()+'. Reload to inspect the decision.');}
      else if (action && 'statementId' in action && action.statementId) setArchived(result);
      else if (action && 'sourceHash' in action) {setCurrent(undefined);setReason('');setMessage('Statement prepared. Reload to inspect the saved evidence.');}
      else setCurrent(result);
    } catch {setCurrent(undefined);setMessage('Statement unavailable. Reload to check current evidence and saved history.');}
    finally {setBusy(false);}
  }
  if (!isCommercialDraftingContextCurrent(context)) return null;
  const evidence=(archived ?? current)?.evidence;
  const latest=current?.history[0];
  const renewal=Boolean(current?.sourceHash && current.sourceHash===latest?.sourceHash && latest.currentPreparer && !latest.review);
  return <section aria-label={'Retainer statement '+startsOn}>
    <button type="button" disabled={busy} className="underline" onClick={()=>load()}>Review period statement</button>
    {message && <p role="status">{message}</p>}
    {evidence && <div><h5>{archived ? 'Saved statement '+archived.record?.sequence : 'Current period evidence'}</h5>
      <p>{version.currency} {evidence.total} · base fee {evidence.baseFee} · overage {evidence.overage}</p>
      {evidence.adoptionId && <p>Hourly rate {evidence.rate} · adoption {evidence.adoptionId} · approval {evidence.approvalId}</p>}
      {evidence.periods.map(p=><details key={p.startsOn}><summary>{p.startsOn} through {p.endsOn} · {p.entryCount} approved work entries</summary>
        <ul>{p.entries.map(e=><li key={e.entryId}>{e.workDate} · {e.hours} hours · {e.billable?'billable':'non-billable'} · worker {e.workerId} · work {e.entryId} · submission {e.submissionId} · decision {e.decisionId}</li>)}</ul></details>)}
      {evidence.totalEntries>100 && <p>Work entries {evidence.entryOffset+1}–{Math.min(evidence.entryOffset+100,evidence.totalEntries)} of {evidence.totalEntries}
        {evidence.entryOffset>0 && <button type="button" disabled={busy} onClick={()=>load({statementId:archived?.record?.id,entriesOffset:Math.max(0,evidence.entryOffset-100)})}>Previous entries</button>}
        {evidence.nextOffset!==null && <button type="button" disabled={busy} onClick={()=>load({statementId:archived?.record?.id,entriesOffset:evidence.nextOffset!})}>Next entries</button>}</p>}</div>}
    {archived?.record?.previousId && <button type="button" className="underline" disabled={busy}
      onClick={()=>load({statementId:archived.record!.previousId!})}>Inspect previous statement</button>}
    {current && !archived && !current.evidence && <p>Resolve excess-hour pricing to prepare this period.</p>}
    {current?.evidence && !current.evidence.closed && !archived && <p>This service period is open. Its statement can be prepared after the UTC end date.</p>}
    {archived?.record?.review && <p>{archived.record.review.decision} · {archived.record.review.activeRole} · {archived.record.review.createdAt} · {archived.record.review.reason}</p>}
    {canDecide && archived?.record?.currentPreparer && !archived.record.review && current?.history[0]?.id===archived.record.id &&
      current.sourceHash===archived.record.sourceHash && <div><label>Review reason<input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
      {(['Approved','Rejected'] as const).map(decision=><button key={decision} type="button" disabled={busy || reason.trim().length<3}
        onClick={()=>load({statementId:archived.record!.id,sourceHash:archived.record!.sourceHash,decision,reason:reason.trim()})}>{decision==='Approved'?'Approve statement':'Reject statement'}</button>)}</div>}
    {canPrepare && current?.sourceHash && current.evidence?.closed && !archived && (renewal || current.sourceHash!==latest?.sourceHash || !latest?.currentPreparer || latest?.review?.decision==='Rejected') && <div>
      <label>Statement reason<input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
      <button type="button" disabled={busy || reason.trim().length<3 || (renewal && latest?.reason===reason.trim())} onClick={()=>load({sourceHash:current.sourceHash!,
        previousId:latest?.id ?? null,reason:reason.trim(),...(renewal ? {renewReviewIdentity:true as const} : {})})}>{renewal?'Renew statement for review':'Prepare statement'}</button></div>}
    {current && current.history.length>0 && <ol>{current.history.map(r=><li key={r.id}>
      <button type="button" disabled={busy} className="underline" onClick={()=>load({statementId:r.id})}>Inspect statement {r.sequence}</button>
      {' · '}{r.createdAt} · {r.activeRole} · {r.reason} · {r.review?.decision ?? 'Awaiting review'}</li>)}</ol>}
  </section>;
}
