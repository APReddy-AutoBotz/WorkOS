import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../services/apiClient';
import { approvedRateSources } from '../services/approvedRateSources';
import {
  captureRateContext,
  governedTmValuations,
  type TmPolicy,
  type TmSource,
  type TmPolicyCommand,
  type TmValuation,
  type TmValuationCommand,
  type TmRates,
} from '../services/governedTmValuations';
import { hasRatePermission, isRateContextCurrent, type RateContext } from '../services/rateCandidates';
type Choice = { id: string; label: string };
type Pending =
  | { kind: 'policy'; command: TmPolicyCommand }
  | { kind: 'valuation'; command: TmValuationCommand; policy: TmPolicy; source: TmSource; rates: TmRates };
export const GovernedTmWorkspace = ({ choices }: { choices: Choice[] }) => {
  const [selection, setSelection] = useState(''),
    [locked, setLocked] = useState(false);
  const canView = [
    'commercial.contracts.view',
    'commercial.rate_candidates.view',
    'commercial.cost_candidates.view',
    'employees.view',
    'commercial.tm_valuation.view',
  ].every(hasRatePermission);
  return (
    <section aria-label="Governed T&M valuation" className="my-4 rounded-xl border p-4">
      <h2>Governed T&M valuation</h2>
      <p>
        Approved work and explicitly adopted native rate sources produce protected operational evidence.
        Billable and cost values are rounded per entry; margin is their difference. This does not authorize
        billing, invoices or statutory revenue.
      </p>
      {!canView ? (
        <p role="status">Separate valuation, billing, cost and worker access are required.</p>
      ) : (
        <>
          <label>
            T&M engagement
            <select
              aria-label="T&M engagement"
              value={selection}
              disabled={locked}
              onChange={(e) => setSelection(e.target.value)}
            >
              <option value="">Choose an engagement</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {selection && <TmEngagement key={selection} engagementId={selection} onLockChange={setLocked} />}
        </>
      )}
    </section>
  );
};
const TmEngagement = ({
  engagementId,
  onLockChange,
}: {
  engagementId: string;
  onLockChange: (locked: boolean) => void;
  key?: string;
}) => {
  const [policies, setPolicies] = useState<TmPolicy[] | null>(null),
    [sources, setSources] = useState<TmSource[]>([]),
    [morePolicies, setMorePolicies] = useState(false),
    [moreSources, setMoreSources] = useState(false),
    [selectedSource, setSelectedSource] = useState(''),
    [selectedPolicy, setSelectedPolicy] = useState(''),
    [rates, setRates] = useState<TmRates | null>(null),
    [snapshot, setSnapshot] = useState<{
      valuation: TmValuation;
      rates?: Pick<Awaited<ReturnType<typeof governedTmValuations.inspect>>, 'billingRate' | 'costRate'>;
    } | null>(null),
    [pending, setPending] = useState<Pending | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [effective, setEffective] = useState(''),
    [currency, setCurrency] = useState(''),
    [precision, setPrecision] = useState(''),
    [rounding, setRounding] = useState(''),
    [aggregation, setAggregation] = useState(''),
    [cap, setCap] = useState(''),
    [exclusions, setExclusions] = useState(''),
    [approval, setApproval] = useState(''),
    [unit, setUnit] = useState(''),
    [policyReason, setPolicyReason] = useState(''),
    [valuationReason, setValuationReason] = useState('');
  const mounted = useRef(false),
    generation = useRef(0),
    inFlight = useRef(false),
    owner = useRef<RateContext | null>(null);
  useEffect(() => {
    onLockChange(busy || !!pending);
    return () => onLockChange(false);
  }, [busy, pending, onLockChange]);
  const clear = (message: string) => {
    ++generation.current;
    owner.current = null;
    inFlight.current = false;
    setPolicies(null);
    setSources([]);
    setSelectedSource('');
    setSelectedPolicy('');
    setRates(null);
    setSnapshot(null);
    setPending(null);
    setEffective('');
    setCurrency('');
    setPrecision('');
    setRounding('');
    setAggregation('');
    setCap('');
    setExclusions('');
    setApproval('');
    setUnit('');
    setPolicyReason('');
    setValuationReason('');
    setBusy(false);
    setNotice(message);
  };
  useEffect(() => {
    mounted.current = true;
    const reset = () => clear('Account, role or scope changed. Unsent valuation inputs cleared.');
    const check = () => {
      if (owner.current && !isRateContextCurrent(owner.current)) reset();
    };
    window.addEventListener('workos:organization-scope-switch-requested', reset);
    window.addEventListener('workos:organization-scope-changed', reset);
    window.addEventListener('focus', check);
    window.addEventListener('storage', check);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('workos:organization-scope-switch-requested', reset);
      window.removeEventListener('workos:organization-scope-changed', reset);
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', check);
    };
  }, [engagementId]);
  const run = async (fn: (c: RateContext) => Promise<void>) => {
    if (inFlight.current) return;
    if (owner.current && !isRateContextCurrent(owner.current)) {
      clear('Account, role or scope changed. Reload.');
      return;
    }
    const n = ++generation.current,
      c = captureRateContext(() => mounted.current && generation.current === n);
    if (!c) {
      clear('An active session and selected scope are required.');
      return;
    }
    owner.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      await fn(c);
    } catch {
      if (mounted.current && n === generation.current)
        setNotice(
          'The operation could not be confirmed. Read the original receipt if offered; otherwise reload.',
        );
    } finally {
      if (mounted.current && n === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const load = () =>
    void run(async (c) => {
      const v = await governedTmValuations.load(engagementId, c);
      setPolicies(v.policies);
      setSources(v.sources);
      setMorePolicies(v.morePolicies);
      setMoreSources(v.moreSources);
      setSelectedSource('');
      setSelectedPolicy('');
      setRates(null);
      setSnapshot(null);
    });
  const loadPolicies = () =>
    void run(async (c) => {
      if (!policies?.length || !morePolicies) return;
      const page = await governedTmValuations.policyPage(
        engagementId,
        c,
        policies[policies.length - 1].sequence,
      );
      setPolicies([...policies, ...page.policies]);
      setMorePolicies(page.truncated);
    });
  const loadSources = () =>
    void run(async (c) => {
      if (!sources.length || !moreSources) return;
      const page = await governedTmValuations.sourcePage(engagementId, c, sources[sources.length - 1]);
      setSources([...sources, ...page.sources]);
      setMoreSources(page.truncated);
    });
  const savePolicy = () => {
    if (
      !policies ||
      pending ||
      !effective ||
      !/^[A-Z]{3}$/.test(currency) ||
      !['0', '1', '2', '3', '4'].includes(precision) ||
      !rounding ||
      !aggregation ||
      !cap ||
      !exclusions ||
      !approval ||
      !unit ||
      policyReason.trim().length < 3
    )
      return;
    const command: TmPolicyCommand = {
      requestId: crypto.randomUUID(),
      engagementId,
      expectedLatestId: policies[0]?.id ?? null,
      effectiveFrom: effective,
      definition: {
        version: 'governed-tm/1',
        currency,
        precision: Number(precision),
        rounding,
        aggregation,
        capTreatment: cap,
        exclusions,
        approvalTreatment: approval,
        unit,
      },
      reason: policyReason.trim(),
    };
    void run(async (c) => {
      setPending({ kind: 'policy', command });
      try {
        const p = await governedTmValuations.policy(command, c);
        setPending(null);
        setPolicies(null);
        setSources([]);
        setPolicyReason('');
        setNotice('Policy ' + p.id + ' recorded. Reload before another action.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setPolicies(null);
          setSources([]);
          setNotice('Policy refused. Reload before a deliberate new request.');
          return;
        }
        throw e;
      }
    });
  };
  const chosenSource = sources.find((x) => x.entryId === selectedSource),
    chosenPolicy = policies?.find((x) => x.id === selectedPolicy);
  const policyDetails = chosenPolicy?.definition as
    | {
        currency: string;
        precision: number;
        rounding: string;
        aggregation: string;
        capTreatment: string;
        exclusions: string;
        approvalTreatment: string;
        unit: string;
      }
    | undefined;
  const inspectRates = () => {
    if (
      !chosenSource ||
      chosenSource.workerStatus === 'Exited' ||
      !chosenPolicy ||
      chosenPolicy.effectiveFrom > chosenSource.workDate
    )
      return;
    const p = chosenPolicy.definition as { currency: string; unit: string };
    void run(async (c) => {
      const [billing, cost] = await Promise.all([
        approvedRateSources.resolve(
          {
            kind: 'billing',
            sourceId: engagementId,
            asOf: chosenSource.workDate,
            currency: p.currency,
            unit: p.unit,
          },
          c,
        ),
        approvedRateSources.resolve(
          {
            kind: 'cost',
            sourceId: chosenSource.workerId,
            asOf: chosenSource.workDate,
            currency: p.currency,
            unit: p.unit,
          },
          c,
        ),
      ]);
      setSnapshot(null);
      if (billing.result !== 'source' || cost.result !== 'source' || !billing.source || !cost.source) {
        setRates(null);
        setNotice(`Adopted sources unavailable: billing ${billing.result}, cost ${cost.result}.`);
        return;
      }
      setRates({
        billingId: billing.source.adoptionId,
        billingAmount: billing.source.amount,
        costId: cost.source.adoptionId,
        costAmount: cost.source.amount,
        currency: p.currency,
        unit: p.unit,
      });
      setNotice('Both exact adopted source versions are ready for review.');
    });
  };
  const calculate = () => {
    if (
      !chosenSource ||
      !chosenPolicy ||
      !rates ||
      pending ||
      chosenSource.valuationId ||
      valuationReason.trim().length < 3
    )
      return;
    const command: TmValuationCommand = {
      requestId: crypto.randomUUID(),
      engagementId,
      policyId: chosenPolicy.id,
      submissionId: chosenSource.submissionId,
      entryId: chosenSource.entryId,
      billingAdoptionId: rates.billingId,
      costAdoptionId: rates.costId,
      reason: valuationReason.trim(),
    };
    void run(async (c) => {
      setPending({ kind: 'valuation', command, policy: chosenPolicy, source: chosenSource, rates });
      try {
        const v = await governedTmValuations.calculate(command, chosenPolicy, chosenSource, rates, c);
        setPending(null);
        setSnapshot({ valuation: v });
        setPolicies(null);
        setSources([]);
        setRates(null);
        setValuationReason('');
        setNotice('Protected T&M snapshot ' + v.id + ' retained. Reload before another calculation.');
      } catch (e) {
        if (e instanceof ApiClientError && [400, 403, 409, 422].includes(e.status)) {
          setPending(null);
          setPolicies(null);
          setSources([]);
          setRates(null);
          setNotice('Calculation refused. Reload exact work, policy and sources.');
          return;
        }
        throw e;
      }
    });
  };
  const inspectSaved = () => {
    if (!chosenSource?.valuationId) return;
    void run(async (c) => {
      const v = await governedTmValuations.inspect(chosenSource.valuationId!, engagementId, chosenSource, c);
      setSnapshot({ valuation: v.valuation, rates: { billingRate: v.billingRate, costRate: v.costRate } });
    });
  };
  const reconcile = () => {
    if (!pending) return;
    void run(async (c) => {
      if (pending.kind === 'policy') {
        const v = await governedTmValuations.policy(pending.command, c, true);
        setNotice('Original policy ' + v.id + ' confirmed by read-only receipt.');
      } else {
        const v = await governedTmValuations.calculate(
          pending.command,
          pending.policy,
          pending.source,
          pending.rates,
          c,
          true,
        );
        setSnapshot({ valuation: v });
        setNotice('Original T&M snapshot ' + v.id + ' confirmed by read-only receipt.');
      }
      setPending(null);
      setPolicies(null);
      setSources([]);
      setRates(null);
    });
  };
  const shown = snapshot?.valuation;
  const canCreate = hasRatePermission('commercial.tm_valuation.create'),
    canPolicy = canCreate && hasRatePermission('commercial.contracts.manage');
  return (
    <div className="space-y-3">
      <button type="button" onClick={load} disabled={busy || !!pending}>
        Load T&M policy and approved work
      </button>
      {policies && morePolicies && (
        <button type="button" onClick={loadPolicies} disabled={busy || !!pending}>
          Load older T&amp;M policies
        </button>
      )}
      {policies && moreSources && (
        <button type="button" onClick={loadSources} disabled={busy || !!pending}>
          Load more approved work
        </button>
      )}
      {policies && (
        <>
          {canPolicy && (
            <fieldset disabled={busy || !!pending}>
              <legend>Explicit T&M policy</legend>
              <p>
                Only no-cap, no-exclusion, no-additional-approval policies are supported. If policy approval
                or a cap is required, this workflow is unavailable.
              </p>
              <label>
                Policy effective date UTC
                <input
                  aria-label="T&M policy effective date UTC"
                  type="date"
                  value={effective}
                  onChange={(e) => setEffective(e.target.value)}
                />
              </label>
              <label>
                Policy currency
                <input
                  aria-label="T&M policy currency"
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </label>
              <label>
                Currency precision
                <select
                  aria-label="T&M currency precision"
                  value={precision}
                  onChange={(e) => setPrecision(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  {['0', '1', '2', '3', '4'].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Rounding mode
                <select
                  aria-label="T&M rounding mode"
                  value={rounding}
                  onChange={(e) => setRounding(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  <option value="HALF_UP">Half up</option>
                  <option value="HALF_EVEN">Half even</option>
                  <option value="DOWN">Down</option>
                </select>
              </label>
              <label>
                Aggregation
                <select
                  aria-label="T&M aggregation"
                  value={aggregation}
                  onChange={(e) => setAggregation(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  <option value="PER_ENTRY">Per work entry</option>
                </select>
              </label>
              <label>
                Cap treatment
                <select aria-label="T&M cap treatment" value={cap} onChange={(e) => setCap(e.target.value)}>
                  <option value="">Choose explicitly</option>
                  <option value="NONE">No cap</option>
                </select>
              </label>
              <label>
                Exclusions
                <select
                  aria-label="T&M exclusions"
                  value={exclusions}
                  onChange={(e) => setExclusions(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  <option value="NONE">No additional exclusions</option>
                </select>
              </label>
              <label>
                Policy approval treatment
                <select
                  aria-label="T&M policy approval treatment"
                  value={approval}
                  onChange={(e) => setApproval(e.target.value)}
                >
                  <option value="">Choose explicitly</option>
                  <option value="NONE">No additional approval required</option>
                </select>
              </label>
              <label>
                Work unit
                <select aria-label="T&M work unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="">Choose explicitly</option>
                  <option value="HOUR">Hour</option>
                </select>
              </label>
              <label>
                Policy reason
                <input
                  aria-label="T&M policy reason"
                  value={policyReason}
                  onChange={(e) => setPolicyReason(e.target.value)}
                />
              </label>
              <button type="button" onClick={savePolicy}>
                Record explicit T&M policy
              </button>
            </fieldset>
          )}
          <label>
            Approved work
            <select
              aria-label="T&M approved work"
              value={selectedSource}
              disabled={busy || !!pending}
              onChange={(e) => {
                setSelectedSource(e.target.value);
                setRates(null);
                setSnapshot(null);
              }}
            >
              <option value="">Choose approved work</option>
              {sources.map((x) => (
                <option key={x.entryId} value={x.entryId}>
                  {x.workDate} · {x.workerName} · {x.hoursExact} hours · {x.workerStatus} ·{' '}
                  {x.valuationId ? 'retained' : 'not yet calculated'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Retained T&M policy
            <select
              aria-label="Retained T&M policy"
              value={selectedPolicy}
              disabled={busy || !!pending}
              onChange={(e) => {
                setSelectedPolicy(e.target.value);
                setRates(null);
                setSnapshot(null);
              }}
            >
              <option value="">Choose explicit policy</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.effectiveFrom} · version {p.sequence}
                </option>
              ))}
            </select>
          </label>
          {chosenSource && (
            <p>
              Work entry {chosenSource.entryId} · approved decision {chosenSource.decisionId} · project
              binding {chosenSource.bindingId}.
            </p>
          )}
          {policyDetails && (
            <p>
              Policy: {policyDetails.currency}, {policyDetails.precision} decimals, {policyDetails.rounding},{' '}
              {policyDetails.aggregation}; cap {policyDetails.capTreatment}, exclusions{' '}
              {policyDetails.exclusions}, additional approval {policyDetails.approvalTreatment}, unit{' '}
              {policyDetails.unit}.
            </p>
          )}
          {chosenSource?.valuationId ? (
            <button type="button" disabled={busy || !!pending} onClick={inspectSaved}>
              Inspect retained T&M snapshot
            </button>
          ) : (
            canCreate && (
              <>
                <button
                  type="button"
                  disabled={
                    busy ||
                    !!pending ||
                    !chosenSource ||
                    chosenSource.workerStatus === 'Exited' ||
                    !chosenPolicy
                  }
                  onClick={inspectRates}
                >
                  Inspect adopted billing and cost sources
                </button>
                {rates && (
                  <>
                    <p>
                      Billing adoption {rates.billingId}: {rates.currency} {rates.billingAmount}/{rates.unit};
                      cost adoption {rates.costId}: {rates.currency} {rates.costAmount}/{rates.unit}.
                    </p>
                    <label>
                      Calculation reason
                      <input
                        aria-label="T&M calculation reason"
                        value={valuationReason}
                        disabled={busy || !!pending}
                        onChange={(e) => setValuationReason(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !!pending || valuationReason.trim().length < 3}
                      onClick={calculate}
                    >
                      Retain T&M snapshot
                    </button>
                  </>
                )}
              </>
            )
          )}
        </>
      )}
      {pending && (
        <div>
          <p>
            Original {pending.kind} request {pending.command.requestId} may still be in flight; no write is
            retried automatically.
          </p>
          <button type="button" disabled={busy} onClick={reconcile}>
            Read original T&M receipt
          </button>
        </div>
      )}
      {shown && (
        <section aria-label="Retained T&M snapshot">
          <h3>Retained calculation</h3>
          <p>
            {shown.result.currency} billable {shown.result.billableValue}, cost {shown.result.costValue},
            margin {shown.result.marginValue}. Work entry {shown.entryId}; policy {shown.policyId}; billing
            adoption {shown.billingAdoptionId}; cost adoption {shown.costAdoptionId}.
          </p>
          {snapshot?.rates && (
            <section aria-label="Historical rate selection">
              <h4>Rate selection for {shown.sourceEvidence.workDate}</h4>
              <p>
                Each rate was the unique highest-priority adopted match for the work date, currency and unit.
              </p>
              <dl>
                {[snapshot.rates.billingRate, snapshot.rates.costRate].map((rate) => (
                  <div key={rate.kind}>
                    <dt>{rate.kind === 'billing' ? 'Billing rate' : 'Cost rate'}</dt>
                    <dd>
                      {rate.currency} {rate.amount} per {rate.unit} · {rate.bindingType} {rate.bindingId} ·
                      priority {rate.priority}
                    </dd>
                    <dd>
                      Effective {rate.effectiveFrom} through {rate.effectiveTo} · candidate {rate.candidateId}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
};
