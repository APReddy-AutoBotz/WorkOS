import {useEffect, useRef, useState} from 'react';
import {ApiClientError} from '../../services/apiClient';

export type AuditReadStatus = 'blocked' | 'loading' | 'ready' | 'access' | 'error';

// A read is usable only for its current actor/selection and attempt. No data is persisted.
export const useAuditRead = <T,>(enabled: boolean, key: string, load: () => Promise<T>, currentKey: () => string) => {
  const requestVersion = useRef(0);
  const readCurrentKey = useRef(currentKey);
  readCurrentKey.current = currentKey;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{key: string; request: number; status: AuditReadStatus; data: T | null}>(
    () => ({key, request: 0, status: enabled ? 'loading' : 'blocked', data: null}),
  );
  const invalidate = () => {
    requestVersion.current += 1;
    setResult({key, request: requestVersion.current, status: enabled ? 'loading' : 'blocked', data: null});
  };
  const refresh = () => { invalidate(); setRetry(value => value + 1); };
  useEffect(() => {
    let active = true;
    const request = ++requestVersion.current;
    setResult({key, request, status: enabled ? 'loading' : 'blocked', data: null});
    const current = () => active && request === requestVersion.current && key === readCurrentKey.current();
    if (enabled) {
      void Promise.resolve().then(() => current() ? load() : null).then(data => {
        if (current()) setResult({key, request, status: 'ready', data});
      }).catch(error => {
        if (current()) {
          // Organization history intentionally uses non-disclosing 404 for unavailable grants.
          const access = error instanceof ApiClientError && [401, 403, 404].includes(error.status);
          setResult({key, request, status: access ? 'access' : 'error', data: null});
        }
      });
    }
    return () => { active = false; };
  }, [enabled, key, load, retry]);
  const isCurrent = () => enabled && result.status === 'ready'
    && result.request === requestVersion.current && result.key === readCurrentKey.current();
  const status = !enabled ? 'blocked' : result.key !== key ? 'loading' : result.status;
  return {status, data: status === 'ready' && isCurrent() ? result.data : null,
    dataVersion: result.request, currentVersion: () => requestVersion.current, isCurrent, invalidate, refresh};
};
