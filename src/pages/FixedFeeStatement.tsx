import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

const frequencies=['Weekly','Monthly','Fiscal'] as const;
const statusText={
  period_missing:'Choose a date that ends a configured reporting period.',
  period_open:'Sign-off requires a financially locked or closed reporting period.',
  opening_unavailable:'Opening valuation evidence requires reconciliation.',
  closing_unavailable:'Closing valuation evidence requires reconciliation.',
  explanation_required:'Explain why the closing balance is below the opening balance before signing.',
  ready:'Both valuation balances are verified.',
};

export function FixedFeeStatement({context,engagement,through}:{context:CommercialDraftingContext;engagement:string;through:string}) {
  const [frequency,setFrequency]=useState<typeof frequencies[number]>('Weekly');
  const [data,setData]=useState<Awaited<ReturnType<typeof commercialDraftingService.fixedFeeStatement>>|null>(null);
  const [explanation,setExplanation]=useState('');
  const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function inspect(version?:number,sign=false) {
    setBusy(true);setMessage('');
    try {
      const command=sign && data?.token?{expectedToken:data.token,reason,...(data.status==='explanation_required'?{reductionExplanation:explanation}:{})}:undefined;
      const result=await commercialDraftingService.fixedFeeStatement(engagement,through,frequency,context,{version,command});
      if (isCommercialDraftingContextCurrent(context)) {setData(result);if (sign) {setReason('');setExplanation('');}}
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {setData(null);setMessage('Inspect the period again to verify sign-off authority and evidence.');}
    } finally {setBusy(false);}
  }
  const signed=data?.saved,report=data?.report;
  return <section aria-label="Fixed-fee period statement"><fieldset disabled={busy}>
    <legend>Management valuation statement through {through}</legend>
    <label>Reporting frequency <select value={frequency} onChange={e=>{
      setFrequency(e.target.value as typeof frequency);setData(null);setReason('');setExplanation('');setMessage('');
    }}>{frequencies.map(f=><option key={f}>{f}</option>)}</select></label>
    <button type="button" onClick={()=>void inspect()}>Inspect period statement</button>
    {data && <p>{statusText[data.status]}</p>}
    {report && <p>{report.currency} · Opening {report.opening.amount} · Closing {report.closing.amount} · Period movement {report.movement}</p>}
    {report && (data?.status==='ready' || data?.status==='explanation_required') && context.canSignFixedFeeStatement && signed?.report.period.revision!==report.period.revision && <>
      <label>Statement sign-off reason <input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
      {data.status==='explanation_required' && <label>Reduction explanation <textarea maxLength={1000} value={explanation} onChange={e=>setExplanation(e.target.value)}/></label>}
      <button disabled={reason.trim().length<3 || (data.status==='explanation_required' && explanation.trim().length<3)} type="button" onClick={()=>void inspect(undefined,true)}>Sign period statement</button>
    </>}
    {signed && <div><p>Signed version {signed.version} · {signed.report.currency} {signed.report.movement} · {signed.reason}</p>
      {signed.reductionExplanation && <p>Reduction explanation: {signed.reductionExplanation}</p>}
      <details><summary>Signed balances and source records</summary>
        <p>Period {signed.report.period.startsOn} to {signed.report.period.endsOn} · Revision {signed.report.period.revision}</p>
        <p>Signed {signed.signedAt} · Signer {signed.actorId} · Statement {signed.id}</p>
        {[signed.report.opening,signed.report.closing].map(b=><p key={b.date}>{b.date} · {b.profile} · {signed.report.currency} {b.amount} · {b.sources.join(', ')||'Before service began'}</p>)}
      </details>
      {signed.version>1 && <button type="button" onClick={()=>void inspect(signed.version-1)}>Previous signed statement</button>}
    </div>}
  </fieldset>{message && <p role="status">{message}</p>}</section>;
}
