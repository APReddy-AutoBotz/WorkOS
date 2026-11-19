import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, ApiClientError } from '../../services/apiClient';
import {
  captureOrganizationProfileContext,
  assertOrganizationProfileContext,
  isOrganizationProfileContextCurrent,
  type OrganizationProfileContext,
} from '../../services/organizationProfileScope';
import { hasRatePermission } from '../../services/rateCandidates';

const base = '/api/v1/organization-setup/financial-periods';
const period = z
  .object({
    id: z.string().min(1),
    code: z.string(),
    name: z.string(),
    frequency: z.enum(['Weekly', 'Monthly', 'Fiscal']),
    startsOn: z.string().date(),
    endsOn: z.string().date(),
    status: z.enum([
      'Planned',
      'Open',
      'Submission Closed',
      'Approval Closed',
      'Financially Locked',
      'Closed',
    ]),
    revision: z.number().int().positive(),
  })
  .strict();
const identity = {
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
  organizationId: z.string(),
  legalEntityId: z.string(),
};
const list = z.object({ ...identity, periods: z.array(period).max(3) }).strict();
const receipt = z.object({ ...identity, period }).strict();
export function FinancialPeriodControl() {
  const [date, setDate] = useState(''),
    [reason, setReason] = useState(''),
    [selected, setSelected] = useState('');
  const [data, setData] = useState<z.infer<typeof list> | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const gen = useRef(0),
    owner = useRef<OrganizationProfileContext | null>(null),
    inFlight = useRef(false);
  const clear = () => {
    ++gen.current;
    owner.current = null;
    inFlight.current = false;
    setData(null);
    setSelected('');
    setReason('');
    setBusy(false);
    setNotice('');
  };
  useEffect(() => {
    const reset = () => {
        clear();
        setDate('');
      },
      check = () => {
        if (owner.current && !isOrganizationProfileContextCurrent(owner.current)) reset();
      };
    window.addEventListener('workos:organization-scope-switch-requested', reset);
    window.addEventListener('workos:organization-scope-changed', reset);
    window.addEventListener('storage', check);
    window.addEventListener('focus', check);
    return () => {
      ++gen.current;
      window.removeEventListener('workos:organization-scope-switch-requested', reset);
      window.removeEventListener('workos:organization-scope-changed', reset);
      window.removeEventListener('storage', check);
      window.removeEventListener('focus', check);
    };
  }, []);
  const current = data?.periods.find((p) => p.id === selected);
  const reopen = current?.status === 'Financially Locked';
  const canAct =
    current &&
    (reopen
      ? hasRatePermission('periods.financial_reopen')
      : ['Open', 'Submission Closed', 'Approval Closed'].includes(current.status));
  const canClose = current && current.status !== 'Closed';
  const run = async (action?: 'lock' | 'reopen' | 'close') => {
    if (inFlight.current) return;
    if (owner.current && !isOrganizationProfileContextCurrent(owner.current)) {
      clear();
      return;
    }
    const sequence = ++gen.current,
      c = captureOrganizationProfileContext(() => gen.current === sequence);
    if (!c) {
      clear();
      return;
    }
    owner.current = c;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      if (action) {
        if (!current || !data || !(action === 'close' ? canClose : canAct) || reason.trim().length < 3) return;
        const raw = await api.requestWithContext(
          'POST',
          base + '/' + encodeURIComponent(current.id) + '/transitions',
          {
            action,
            expectedOwnerKey: data.ownerKey,
            expectedRevision: current.revision,
            reason: reason.trim(),
          },
          c,
        );
        assertOrganizationProfileContext(c);
        const result = receipt.parse(raw);
        if (
          result.ownerKey !== data.ownerKey ||
          result.organizationId !== c.scope.organizationId ||
          result.legalEntityId !== c.scope.legalEntityId ||
          result.period.id !== current.id ||
          result.period.revision !== current.revision + 1 ||
          result.period.status !== { reopen: 'Approval Closed', lock: 'Financially Locked', close: 'Closed' }[action]
        )
          throw new Error();
        setData({ ...data, periods: data.periods.map((p) => (p.id === current.id ? result.period : p)) });
        setReason('');
        setNotice(current.code + ' is now ' + result.period.status + '.');
      } else {
        setData(null);
        setSelected('');
        setReason('');
        const raw = await api.requestWithContext(
          'GET',
          base + '?' + new URLSearchParams({ date }),
          undefined,
          c,
        );
        assertOrganizationProfileContext(c);
        const result = list.parse(raw);
        if (
          result.organizationId !== c.scope.organizationId ||
          result.legalEntityId !== c.scope.legalEntityId ||
          result.periods.some((p) => p.startsOn > date || p.endsOn < date)
        )
          throw new Error();
        setData(result);
      }
    } catch (e) {
      if (sequence === gen.current) {
        setData(null);
        setSelected('');
        setReason('');
        setNotice(
          e instanceof ApiClientError && e.status === 403
            ? 'Access to the period changed.'
            : 'Reload the period to verify its current state.',
        );
      }
    } finally {
      if (sequence === gen.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      aria-label="Financial period controls"
      className="mt-8 space-y-3 rounded-3xl border border-border-light bg-white p-6"
    >
      <h2 className="text-lg font-bold">Financial period controls</h2>
      <fieldset disabled={busy} className="space-y-2">
        <label>
          Reporting date{' '}
          <input
            type="date"
            value={date}
            onChange={(e) => {
              clear();
              setDate(e.target.value);
            }}
          />
        </label>
        <button type="button" disabled={!date} onClick={() => void run()}>
          Inspect reporting periods
        </button>
        {data &&
          (data.periods.length === 0 ? (
            <p>No reporting periods cover this date.</p>
          ) : (
            <label>
              Reporting period{' '}
              <select
                aria-label="Reporting period"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setReason('');
                  setNotice('');
                }}
              >
                <option value="">Choose a period</option>
                {data.periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.frequency} · {p.code} · {p.status}
                  </option>
                ))}
              </select>
            </label>
          ))}
        {current && (
          <p>
            {current.name} · {current.startsOn} through {current.endsOn} · {current.status} · revision{' '}
            {current.revision}
          </p>
        )}
        {(canAct || canClose) && (
          <>
            {reopen && canAct && (
              <p>
                Reopening permits valuation of approved work. Submissions and approval decisions stay closed.
              </p>
            )}
            <label>
              Financial transition reason{' '}
              <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </label>
            {canAct && (
              <button
                type="button"
                disabled={reason.trim().length < 3}
                onClick={() => void run(reopen ? 'reopen' : 'lock')}
              >
                {reopen ? 'Reopen for financial valuation' : 'Financially lock period'}
              </button>
            )}
            {canClose && (
              <button type="button" disabled={reason.trim().length < 3} onClick={() => void run('close')}>
                Permanently close period
              </button>
            )}
          </>
        )}
      </fieldset>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
