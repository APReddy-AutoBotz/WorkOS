import {useRef,useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

type RiskPage=Awaited<ReturnType<typeof commercialDraftingService.retainerRisks>>;
export function RetainerRiskRegister({context}:{context:CommercialDraftingContext}) {
  const [page,setPage]=useState<RiskPage|null>(null);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  async function load(after:string|null) {
    if (pending.current || !isCommercialDraftingContextCurrent(context)) return;
    pending.current=true;setBusy(true);setMessage('');
    try {
      const next=await commercialDraftingService.retainerRisks(after,context);
      if (isCommercialDraftingContextCurrent(context)) setPage(next);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {setPage(null);setMessage('Could not load retainer risks. Check your current access.');}
    } finally {pending.current=false;setBusy(false);}
  }
  return <fieldset disabled={busy}><legend>Retainer capacity risks</legend>
    <button type="button" onClick={()=>void load(null)}>Check governed retainer versions</button>
    {message && <p role="alert">{message}</p>}
    {page && <div><p>{page.scannedVersions} governed versions checked on this page · {page.asOf} UTC</p>
      {!page.findings.length && <p>No retainer capacity findings on this page.</p>}
      <ul>{page.findings.map(r=><li key={JSON.stringify([r.versionId,r.kind,'startsOn' in r?r.startsOn:null])}>
        <strong>{r.number} · Version {r.version}</strong>{r.kind==='missing_policy'?' · Capacity policy missing':
          r.kind==='review_terms'?' · '+r.startsOn+' through '+r.endsOn+' · Review capacity coverage':
          ' · '+r.startsOn+' through '+r.endsOn+' · '+r.hours+(r.kind==='expiry'?' unused hours expired':' hours over capacity')}
      </li>)}</ul>
      {page.nextAfter && <button type="button" onClick={()=>void load(page.nextAfter)}>Check next retainer versions</button>}
    </div>}
  </fieldset>;
}
