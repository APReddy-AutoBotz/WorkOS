import { invoiceDraftTotal } from '../../shared/invoice-batch-draft.mjs';
import { useEffect, useRef, useState } from 'react';
import { InvoiceLineReversal } from './InvoiceLineReversal';
import { ApiClientError } from '../services/apiClient';
import {
  captureRateContext,
  invoiceCsv,
  type IssuedCredit,
  type InvoiceLinePricing,
  type CreditExportLink,
  type CorrectionEvidence,
  type InvoiceCsvSource,
  type InvoiceCsvArtifact,
  type InvoiceCsvOperation,
} from '../services/invoiceCsv';
import { invoiceDrafts, type InvoiceDraft } from '../services/invoiceDrafts';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
type Choice = { id: string; label: string };
type Verified = { artifact: InvoiceCsvArtifact; bytes: Uint8Array };
export const InvoiceCsvWorkspace = ({ choices }: { choices: Choice[] }) => {
  const [engagement, setEngagement] = useState(''),
    [locked, setLocked] = useState(false),
    canRead = [
      'commercial.contracts.view',
      'commercial.tm_billing.view',
      'commercial.invoice_drafts.view',
      'commercial.invoice_export.view',
      'employees.view',
      'notifications.view',
    ].every(hasRatePermission);
  return (
    <section aria-label="Invoice CSV export" className="my-4 space-y-3 rounded-xl border p-4">
      <h2>Invoice CSV export</h2>
      <p>
        Export only an approved batch with an explicitly configured invoice notification policy and alert
        route. The versioned CSV encodes arbitrary identifiers and billing evidence in reversible Base64
        columns; consumers must decode those fields.
      </p>
      {!canRead ? (
        <p role="status">Scoped invoice export access is required.</p>
      ) : (
        <>
          <label>
            Invoice export engagement
            <select
              aria-label="Invoice export engagement"
              value={engagement}
              disabled={locked}
              onChange={(e) => setEngagement(e.target.value)}
            >
              <option value="">Choose an engagement</option>
              {choices.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          {engagement && (
            <InvoiceCsvEngagement key={engagement} engagementId={engagement} onLockChange={setLocked} />
          )}
        </>
      )}
    </section>
  );
};
const InvoiceCsvEngagement = ({
  engagementId,
  onLockChange,
}: {
  engagementId: string;
  onLockChange: (v: boolean) => void;
  key?: string;
}) => {
  const [drafts, setDrafts] = useState<InvoiceDraft[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false),
    [selected, setSelected] = useState(''),
    [source, setSource] = useState<InvoiceCsvSource | null>(null),
    [version, setVersion] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState(''),
    [pending, setPending] = useState<InvoiceCsvOperation | null>(null),
    [verified, setVerified] = useState<Verified | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [lastRequestId, setLastRequestId] = useState(''),
    [notificationStatus, setNotificationStatus] = useState('');
  const [credits,setCredits] = useState<IssuedCredit[]|null>(null);
  const [creditCursor,setCreditCursor] = useState<string|null>(null);
  const [evidence,setEvidence]=useState<CorrectionEvidence|null>(null);
  const [chosen,setChosen] = useState<IssuedCredit[]>([]);
  const [creditReason,setCreditReason] = useState('');
  const [corrections,setCorrections]=useState<{id:string;currency:string;state:string}[]>([]);
  const [correctionNext,setCorrectionNext]=useState<string|null>(null);
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    context = useRef<RateContext | null>(null);
  useEffect(() => {
    onLockChange(busy || !!pending);
    return () => onLockChange(false);
  }, [busy, pending, onLockChange]);
  const clear = (message: string) => {
    ++generation.current;
    context.current = null;
    inFlight.current = false;
    setChosen([]);
    setCreditReason('');
    setEvidence(null);
    setCredits(null);
    setCreditCursor(null);
    setDrafts([]);setCorrections([]);setCorrectionNext(null);
    setNext(null);
    setLoaded(false);
    setSelected('');
    setSource(null);
    setVersion('');
    setConfirmed(false);
    setReason('');
    setPending(null);
    setVerified(null);
    setLastRequestId('');
    setNotificationStatus('');
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const block = () =>
      clear('Account, role or scope changed. Unsent export inputs and locally held bytes were cleared.');
    const check = () => {
      if (context.current && !isRateContextCurrent(context.current)) block();
    };
    window.addEventListener('workos:organization-scope-switch-requested', block);
    window.addEventListener('workos:organization-scope-changed', block);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', block);
      window.removeEventListener('workos:organization-scope-changed', block);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', check);
    };
  }, [engagementId]);
  const run = async (fn: (c: RateContext) => Promise<void>) => {
    if (inFlight.current) return;
    if (context.current && !isRateContextCurrent(context.current)) {
      clear('Account, role or scope changed. Reload.');
      return;
    }
    const n = ++generation.current,
      c = captureRateContext(() => mounted.current && generation.current === n);
    if (!c) {
      clear('An active session and selected scope are required.');
      return;
    }
    context.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      await fn(c);
    } catch {
      if (mounted.current && generation.current === n)
        setNotice(
          'The operation could not be confirmed. Read the original receipt if offered; otherwise reload.',
        );
    } finally {
      if (mounted.current && generation.current === n) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const loadCredits = (after:string|null) => void run(async c => {
    setChosen([]);
    setCreditReason('');
    setEvidence(null);
    setCredits(null);
    setCreditCursor(null);
    const result = await invoiceCsv.issuedCredits(engagementId,after,c);
    setCredits(result.credits);
    setCreditCursor(result.nextAfter);
  });
  const changeReservation = (originalId:string,selection:string[]|string,expectedState:'Draft'|'Approved'='Draft') => void run(async c=>{
    const why=creditReason.trim();
    setChosen([]);
    setEvidence(null);
    setCredits(null);
    setCreditReason('');
    setCreditCursor(null);
    const receipt=await invoiceCsv.correctionDraft(originalId,crypto.randomUUID(),why,selection,c,expectedState);
    if(Array.isArray(selection) && (receipt.currency!==chosen[0]?.currency || receipt.total!== '-'+invoiceDraftTotal(chosen.map(x=>x.amount.slice(1))).amount)) {
      throw Error('Correction total changed');
    }
    const result=await invoiceCsv.issuedCredits(engagementId,null,c);
    setCredits(result.credits);
    setCreditCursor(result.nextAfter);
    setNotice('Correction batch '+receipt.batchId+' · '+receipt.state+' · '+receipt.currency+' '+receipt.total);
  });
  const load = () =>
    void run(async (c) => {
      const x = await invoiceDrafts.list(c);
      setDrafts(x.batches);setCorrections([]);setCorrectionNext(null);
      setNext(x.nextAfter);
      setLoaded(true);
      setSelected('');
      setSource(null);
      setVerified(null);
      setConfirmed(false);
    });
  const findCorrections=(after:string|null)=>void run(async c=>{
    const page=await invoiceCsv.correctionBatches(engagementId,after,c);
    setCorrections(old=>after?[...old,...page.batches]:page.batches);
    setCorrectionNext(page.nextAfter);
    if(!page.batches.length)setNotice('No approved or exported correction batches on this page.');
  });
  const more = () => {
    if (next)
      void run(async (c) => {
        const x = await invoiceDrafts.list(c, next);
        setDrafts((old) => [...old, ...x.batches]);
        setNext(x.nextAfter);
      });
  };
  const inspect = () => {
    if (selected)
      void run(async (c) => {
        const x = await invoiceCsv.source(selected, c);
        if (x.engagementId !== engagementId) throw Error('Engagement changed');
        setSource(x);
        setConfirmed(false);
        setVerified(null);
      });
  };
  const perform = (op: InvoiceCsvOperation) => {
    if (pending) return;
    void run(async (c) => {
      setPending(op);
      setLastRequestId(op.requestId);
      setNotificationStatus('');
      try {
        const x = await invoiceCsv.run(op, c);
        setPending(null);
        setLoaded(false);
        setSource(null);
        if (x.artifact && x.bytes) {
          setVerified({ artifact: x.artifact, bytes: x.bytes });
          setNotice('The approved CSV artifact was accepted and verified.');
        } else {
          setVerified(null);
          setNotice('CSV generation failed and was recorded. The batch remains approved.');
        }
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setLoaded(false);
          setSource(null);
          setNotice('The operation was refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const reconcile = () => {
    if (pending)
      void run(async (c) => {
        const x = await invoiceCsv.run(pending, c, true);
        setPending(null);
        setLoaded(false);
        setSource(null);
        if (x.artifact && x.bytes) {
          setVerified({ artifact: x.artifact, bytes: x.bytes });
          setNotice('The original artifact receipt and bytes were confirmed.');
        } else {
          setVerified(null);
          setNotice('The original generation failure was confirmed.');
        }
      });
  };
  const retrieve = () => {
    if (source?.artifactId)
      void run(async (c) => {
        const x = await invoiceCsv.artifact(source.artifactId!, c);
        if (x.artifact.batchId !== source.id) throw Error('Batch changed');
        setVerified(x);
        setNotice('The retained artifact bytes and checksum were verified.');
      });
  };
  const create = () => {
    if (
      !source ||
      source.state !== 'Approved' ||
      !source.sourceCurrent ||
      !source.approvalId ||
      !source.finalTransitionId ||
      !source.lineageHash ||
      !source.control ||
      version !==
        (source.sourceType==='FULL_LINE_REVERSAL' ? 'workos.invoice-credit-csv/1' : source.sourceType === 'MILESTONE_ACCEPTANCE'
          ? 'workos.invoice-milestone-csv/1'
          : 'workos.invoice-tm-csv/1') ||
      !confirmed ||
      reason.trim().length < 3
    )
      return;
    perform({
      requestId: crypto.randomUUID(),
      batchId: source.id,
      approvalId: source.approvalId,
      finalTransitionId: source.finalTransitionId,
      lineageHash: source.lineageHash,
      schemaVersion:
        source.sourceType==='FULL_LINE_REVERSAL' ? 'workos.invoice-credit-csv/1' : source.sourceType === 'MILESTONE_ACCEPTANCE'
          ? 'workos.invoice-milestone-csv/1'
          : 'workos.invoice-tm-csv/1',
      expectedLineCount: source.control.lineCount,
      expectedTotal: source.control.total,
      reason: reason.trim(),
    });
  };
  const download = () => {
    if (!verified || !context.current || !isRateContextCurrent(context.current)) {
      clear('Account, role or scope changed. Reload.');
      return;
    }
    const bytes = Uint8Array.from(verified.bytes),
      url = URL.createObjectURL(new Blob([bytes.buffer], { type: 'text/csv;charset=utf-8' })),
      link = document.createElement('a');
    link.href = url;
    link.download = `invoice-ready-${verified.artifact.id}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const checkNotification = () => {
    if (lastRequestId)
      void run(async (c) => {
        const x = await invoiceCsv.notificationStatus(lastRequestId, c);
        setNotificationStatus(
          x.state === 'Recorded'
            ? 'Notification event recorded.'
            : x.state === 'DeliveryIncomplete'
              ? 'Notification delivery needs recovery.'
              : 'Notification event needs recovery.',
        );
        if (x.alertOutbox === 'Pending')
          setNotificationStatus(
            (t) => t + ' Internal alert route is pending; no external delivery was performed.',
          );
      });
  };
  const canCreate = hasRatePermission('commercial.invoice_export.create');
  return (
    <div className="space-y-3">
      <button type="button" disabled={busy || !!pending} onClick={load}>
        Load invoice export batches
      </button>
      {hasRatePermission('commercial.invoice_drafts.prepare') && <section aria-label="Issued billing credits">
        <button type="button" disabled={busy || !!pending} onClick={()=>loadCredits(null)}>View issued credits</button>
        {credits && (credits.length ? <table>
          <caption>Issued credits for this engagement</caption>
          <thead><tr><th>Eligibility date</th><th>Credit</th><th>Original batch</th><th>Original line</th><th>Register item</th><th>Correction batch</th></tr></thead>
          <tbody>{credits.map(row=><tr key={row.itemId}><td>{row.eligibleOn}</td><td>{row.currency} {row.amount}</td>
            <td>{row.batchId}</td><td>{row.lineId}</td><td><span>{row.itemId}</span>
              <details><summary>Credit evidence</summary><dl>
                <dt>Eligibility event</dt><dd>{row.eventId}</dd>
                <dt>Original eligibility event</dt><dd>{row.originalEventId}</dd>
                <dt>Final reversal decision</dt><dd>{row.decisionId}</dd>
              </dl></details></td><td>{row.correctionBatchId ? <>{row.correctionState} · {row.correctionBatchId}
              <button type="button" disabled={busy || !!pending} onClick={()=>void run(async c=>{
                setEvidence(null);
                setEvidence(await invoiceCsv.correctionEvidence(row,engagementId,c));
              })}>Inspect correction draft</button>
              {(row.correctionState==='Draft' || row.correctionState==='Approved') && hasRatePermission('commercial.invoice_drafts.cancel') && <button type="button" disabled={busy || !!pending || creditReason.trim().length<3}
                onClick={()=>changeReservation(row.batchId,row.correctionBatchId!,row.correctionState==='Approved'?'Approved':'Draft')}>Cancel correction batch</button>}</>
              : hasRatePermission('commercial.invoice_drafts.own') ? <label><input type="checkbox" checked={chosen.some(x=>x.itemId===row.itemId)}
                disabled={busy || !!pending || (chosen.length>0 && chosen[0].batchId!==row.batchId)}
                onChange={e=>setChosen(e.target.checked?[...chosen,row]:chosen.filter(x=>x.itemId!==row.itemId))}/>Select credit {row.itemId}</label> : 'Available'}
            </td></tr>)}</tbody>
        </table> : <p>No issued credits on this page.</p>)}
        {evidence && <section aria-label="Correction draft evidence">
          <h3>Correction draft {evidence.header.batchId}</h3>
          <p>{evidence.header.state} · {evidence.header.currency} {evidence.header.total} · eligible {evidence.header.periodStart} to {evidence.header.periodEnd}</p>
          <p>{evidence.header.ownerCurrent ? 'Current owner' : 'Owner unavailable'} · {evidence.header.ownerRole} · {evidence.header.ownerId}</p>
          <p>Original export {evidence.originalId} · CSV checksum {evidence.lines[0].artifactSha256}</p>
          <p>Correction line checksum {evidence.header.lineageHash}</p>
          <ol>{evidence.lines.map(x=><li key={x.lineId}>{x.currency} {x.amount} · {x.reserved?'Reserved':'Released'} · original line {x.originalLineId}
            {' · credit item '}{x.itemId} v{x.itemVersion} · eligibility event {x.eventId} v{x.eventVersion} · decision {x.decisionId}</li>)}</ol>
        </section>}
        {!!credits?.length && (hasRatePermission('commercial.invoice_drafts.own') || hasRatePermission('commercial.invoice_drafts.cancel')) && <label>
          Correction batch reason <input disabled={busy || !!pending} maxLength={1000} value={creditReason} onChange={e=>setCreditReason(e.target.value)}/></label>}
        {chosen.length>0 && <p>Selected credits · {chosen[0].currency} -{invoiceDraftTotal(chosen.map(row=>row.amount.slice(1))).amount} · original batch {chosen[0].batchId}</p>}
        {chosen.length>0 && <button type="button" disabled={busy || !!pending || creditReason.trim().length<3}
          onClick={()=>changeReservation(chosen[0].batchId,chosen.map(row=>row.itemId))}>Reserve selected credits</button>}
        {creditCursor && <button type="button" disabled={busy || !!pending} onClick={()=>loadCredits(creditCursor)}>Next credit page</button>}
      </section>}

      {notice && <p role="status">{notice}</p>}
      {lastRequestId && !pending && (
        <button type="button" disabled={busy} onClick={checkNotification}>
          Check invoice notification status
        </button>
      )}
      {notificationStatus && <p role="status">{notificationStatus}</p>}
      {pending && (
        <div>
          <p>
            Original export request {pending.requestId} may still be in flight; no write is retried
            automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original invoice export receipt
          </button>
        </div>
      )}
      {verified && (
        <section aria-label="Verified invoice CSV">
          <p>
            Artifact {verified.artifact.id} · schema {verified.artifact.schemaVersion} · SHA-256{' '}
            {verified.artifact.sha256} · {verified.artifact.lineCount} lines · {verified.artifact.currency}{' '}
            {verified.artifact.total}.
          </p>
          <button type="button" disabled={busy || !!pending} onClick={download}>
            Download verified invoice CSV
          </button>
        </section>
      )}
      {loaded && (
        <>
          <label>
            Batch
            <select
              aria-label="Invoice export batch"
              value={selected}
              disabled={busy || !!pending}
              onChange={(e) => {
                setSelected(e.target.value);
                setSource(null);
                setVerified(null);
              }}
            >
              <option value="">Choose a batch</option>
              {corrections.map(x=><option value={x.id} key={x.id}>{x.state} credit · {x.id} · {x.currency}</option>)}
              {drafts
                .filter(
                  (x) =>
                    x.engagementId === engagementId &&
                    ['Approved', 'Exported', 'Billed/Confirmed'].includes(x.state),
                )
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.state} · {x.id} · {x.currency}
                  </option>
                ))}
            </select>
          </label>
          <button type="button" disabled={busy || !!pending} onClick={()=>findCorrections(null)}>Find credit exports</button>
          {correctionNext && <button type="button" disabled={busy || !!pending} onClick={()=>findCorrections(correctionNext)}>More credit exports</button>}
          {next && (
            <button type="button" disabled={busy || !!pending} onClick={more}>
              More invoice export batches
            </button>
          )}
          <button type="button" disabled={busy || !!pending || !selected} onClick={inspect}>
            Inspect invoice export source
          </button>
          {source && (
            <section aria-label="Inspected invoice export source">
              <p>
                {source.state} · client {source.clientId} · contract {source.contractId} · {source.currency} ·
                period {source.periodStart} to {source.periodEnd} ({source.periodBasis}) · source current{' '}
                {String(source.sourceCurrent)}.
              </p>
              <p>
                Final approval {source.approvalId} · decision {source.finalTransitionId} · lineage{' '}
                {source.lineageHash}.
              </p>
              <ul>
                {source.lines.map((x) => (
                  <li key={x.lineId}>
                    Line {x.lineId} · item {x.itemId} · event {x.eventId} ·{' '}
                    {'sourceType' in x && x.sourceType==='FULL_LINE_REVERSAL' ? `credit against original line ${x.originalLineId} · artifact ${x.originalArtifactId}` : 'sourceType' in x ? `milestone ${x.milestoneId}` : `snapshot ${x.snapshotId}`} ·{' '}
                    {x.currency} {x.amount}
                    {!('sourceType' in x) && hasRatePermission('commercial.rate_candidates.view') &&
                      <LinePricing disabled={busy || !!pending} run={run} load={c=>invoiceCsv.linePricing(source.id,x,c)}/>}
                  </li>
                ))}
              </ul>
              {source.control && (
                <p>
                  Control total {source.control.lineCount} lines · {source.control.currency}{' '}
                  {source.control.total}.
                </p>
              )}
              {['Exported', 'Billed/Confirmed'].includes(source.state) && source.artifactId && (
                <button type="button" disabled={busy || !!pending} onClick={retrieve}>
                  Retrieve retained invoice CSV
                </button>
              )}
              {source.sourceType!=='FULL_LINE_REVERSAL' && verified && source.artifactId === verified.artifact.id && source.id === verified.artifact.batchId &&
                (source.state === 'Exported' || source.state === 'Billed/Confirmed') && hasRatePermission('commercial.invoice_drafts.prepare') && (
                  <InvoiceLineReversal key={source.id + source.state} source={source} state={source.state} artifact={verified.artifact}
                    run={run} disabled={busy || !!pending} />
                )}
              {source.sourceType!=='FULL_LINE_REVERSAL' && source.artifactId && <ExportedCredits key={source.artifactId} original={source} run={run} disabled={busy || !!pending}/>}
              {canCreate && source.state === 'Approved' && (
                <fieldset disabled={busy || !!pending}>
                  <legend>Accept approved CSV artifact</legend>
                  <label>
                    CSV schema
                    <select
                      aria-label="Invoice CSV schema"
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                    >
                      <option value="">Choose</option>
                      {source.sourceType==='FULL_LINE_REVERSAL' ? <option value="workos.invoice-credit-csv/1">Credit CSV v1</option> : source.sourceType === 'MILESTONE_ACCEPTANCE' ? (
                        <option value="workos.invoice-milestone-csv/1">
                          Milestone invoice CSV v1
                        </option>
                      ) : (
                        <option value="workos.invoice-tm-csv/1">T&M invoice CSV v1</option>
                      )}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I inspected the final approval, retained lineage and control total
                  </label>
                  <label>
                    Export reason
                    <input
                      aria-label="Invoice CSV reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button type="button" onClick={create}>
                    Accept invoice CSV artifact
                  </button>
                </fieldset>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
};


function LinePricing({disabled,run,load}:{disabled:boolean;run:(f:(c:RateContext)=>Promise<void>)=>Promise<void>;load:(c:RateContext)=>Promise<InvoiceLinePricing>}){
  const [pricing,setPricing]=useState<InvoiceLinePricing|null>(null);
  return <div>
    <button type="button" disabled={disabled} onClick={()=>void run(async c=>{setPricing(null);setPricing(await load(c));})}>Inspect line pricing</button>
    {pricing && <section aria-label="Retained invoice line pricing">
      <p>{pricing.hours} hours × {pricing.currency} {pricing.rate} = {pricing.rawAmount}.</p>
      <p>{pricing.ceiling===null?'Uncapped':`Per-entry ceiling ${pricing.currency} ${pricing.ceiling}`} · rounding basis {pricing.roundingBasis} · {pricing.rounding} at {pricing.precision} decimal places · invoice amount {pricing.currency} {pricing.amount}.</p>
      <p>Work date {pricing.workDate} · valuation policy {pricing.policyId} effective {pricing.policyEffectiveFrom}.</p>
      <p>Billing rate {pricing.rateCandidateId} effective {pricing.rateFrom} through {pricing.rateTo} · adoption {pricing.billingAdoptionId}.</p>
    </section>}
  </div>;
}

function ExportedCredits({original,run,disabled}:{key?:string;original:InvoiceCsvSource;disabled:boolean;run:(f:(c:RateContext)=>Promise<void>)=>Promise<void>}){
  const [links,setLinks]=useState<CreditExportLink[]|null>(null),[next,setNext]=useState<string|null>(null);
  const load=(after:string|null)=>void run(async c=>{
    setLinks(null);setNext(null);
    const result=await invoiceCsv.exportedCredits(original,after,c);
    setLinks(result.lines);setNext(result.nextAfter);
  });
  return <section aria-label="Exported credits against original lines">
    <button type="button" disabled={disabled} onClick={()=>load(null)}>Check exported credits</button>
    {links && (links.length ? <ul>{links.map(l=><li key={l.lineId}>{l.currency} {l.amount} · original line {l.originalLineId}
      {' · credit batch '}{l.batchId} · credit artifact {l.artifactId} · SHA-256 {l.sha256} · {l.applicationAttested ? 'Downstream application attested' : 'Awaiting downstream attestation'}</li>)}</ul> : <p>No exported credits on this page.</p>)}
    {next && <button type="button" disabled={disabled} onClick={()=>load(next)}>Next exported credits</button>}
  </section>;
}
