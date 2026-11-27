import {useState} from 'react';
import {commercialDraftingService,isCommercialDraftingContextCurrent,type CommercialDraftingContext} from '../services/commercialDrafting';

const labels={Below:'Below threshold',AtOrAbove:'At or above threshold',Unavailable:'Percentage unavailable',Unretained:'No retained version'};
export function MarginPortfolio({context,today}:{context:CommercialDraftingContext;today:string}) {
  const [month,setMonth]=useState(today.slice(0,7));
  const [threshold,setThreshold]=useState('');
  const [page,setPage]=useState<Awaited<ReturnType<typeof commercialDraftingService.portfolioMargins>>|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [retryAfter,setRetryAfter]=useState<string|null>(null);
  async function inspect(after:string|null) {
    setPending(true); setError(''); setPage(null); setRetryAfter(null);
    try {
      const result=await commercialDraftingService.portfolioMargins(month+'-01',threshold,after,context);
      if (isCommercialDraftingContextCurrent(context)) setPage(result);
    } catch {
      if (isCommercialDraftingContextCurrent(context)) {
        setRetryAfter(after);
        setError('Could not load the margin portfolio. Review your access and try again.');
      }
    } finally {setPending(false);}
  }
  return <section aria-label="Managed-service margin portfolio">
    <h3>Managed-service margin portfolio</h3>
    <fieldset disabled={pending}>
      <label>Portfolio month<input type="month" value={month} max={today.slice(0,7)} onChange={e=>{setMonth(e.target.value);setPage(null);setError('');setRetryAfter(null);}}/></label>
      <label>Margin threshold (%)<input value={threshold} onChange={e=>{setThreshold(e.target.value);setPage(null);setError('');setRetryAfter(null);}}/></label>
      <button type="button" disabled={!month || month>today.slice(0,7) || !/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(threshold)} onClick={()=>void inspect(null)}>Inspect portfolio</button>
      {page && (page.items.length ? <table><caption>Latest retained margins for {month}</caption>
        <thead><tr><th>Engagement</th><th>Version</th><th>Margin (%)</th><th>Assessment</th></tr></thead>
        <tbody>{page.items.map(row=><tr key={row.id}><td>{row.name}</td><td>{row.version??'-'}</td><td>{row.percent??'-'}</td><td>{labels[row.status]}</td></tr>)}</tbody>
      </table> : <p>No visible managed-service engagements for this month.</p>)}
      {retryAfter && <button type="button" onClick={()=>void inspect(retryAfter)}>Retry next engagements</button>}
      {page?.next && <button type="button" onClick={()=>void inspect(page.next)}>Next engagements</button>}
    </fieldset>
    {error && <p role="status">{error}</p>}
  </section>;
}
