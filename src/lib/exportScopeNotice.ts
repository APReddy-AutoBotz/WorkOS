const EXPORT_SCOPE_SWITCH_NOTICE_KEY = 'workos_import_export_scope_switch_notice';
const EXPORT_SCOPE_SWITCH_NOTICE_TTL_MS = 60_000;
export const EXPORT_SCOPE_SWITCH_NOTICE = 'An export was in progress when the organization/entity scope changed. It may have been canceled or downloaded under the original scope; check Import History there before retrying.';

let activeExportCount = 0;

export const beginTrackedExport = () => {
  activeExportCount += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeExportCount = Math.max(0, activeExportCount - 1);
  };
};

const persistExportScopeSwitchNotice = () => {
  if (activeExportCount === 0) return;
  try {
    sessionStorage.setItem(EXPORT_SCOPE_SWITCH_NOTICE_KEY, JSON.stringify({
      expiresAt: Date.now() + EXPORT_SCOPE_SWITCH_NOTICE_TTL_MS,
    }));
  } catch {
    // The current page still reports the in-flight export when storage is unavailable.
  }
};

export const listenForExportScopeSwitch = () => {
  window.addEventListener('workos:organization-scope-changed', persistExportScopeSwitchNotice);
  return () => window.removeEventListener('workos:organization-scope-changed', persistExportScopeSwitchNotice);
};

export const consumeExportScopeSwitchNotice = () => {
  try {
    const serializedNotice = sessionStorage.getItem(EXPORT_SCOPE_SWITCH_NOTICE_KEY);
    if (!serializedNotice) return '';
    sessionStorage.removeItem(EXPORT_SCOPE_SWITCH_NOTICE_KEY);
    const notice = JSON.parse(serializedNotice) as { expiresAt?: number };
    return typeof notice.expiresAt === 'number' && notice.expiresAt >= Date.now()
      ? EXPORT_SCOPE_SWITCH_NOTICE
      : '';
  } catch {
    return '';
  }
};
