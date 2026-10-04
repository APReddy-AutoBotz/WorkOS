/**
 * authService.ts — Dual-mode authentication.
 * API mode: calls POST /api/auth/login, stores token in sessionStorage.
 * Demo mode: validates against localStorage accounts (SHA-256, existing behavior).
 */
import { UserAccount, UserRole, UserSession, CountryDirector, UserPermissionGrant, RolePermissionSetting } from '../types';
import { DataStorage, STORAGE_KEYS } from './storage';
import { checkBackend, storeToken, clearToken, getApiHeaders, resetBackendCheck, isDemoFallbackAllowed } from './apiClient';
import { getDefaultPermissionsForRole, getEffectivePermissions } from './permissions';

const SESSION_KEY = 'workos_session';

// ─── SHA-256 helper (demo mode only) ─────────────────────────────────────────
const sha256 = async (value: string) => {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const normalize = (v: string) => v.trim().toLowerCase();

const findAccount = (identifier: string): UserAccount | undefined => {
  const lookup = normalize(identifier);
  const accounts = DataStorage.get<UserAccount[]>(STORAGE_KEYS.USER_ACCOUNTS, []);
  return accounts.find(a =>
    normalize(a.userName) === lookup ||
    normalize(a.email) === lookup ||
    normalize(a.employeeId) === lookup
  );
};

const buildSession = (account: UserAccount, role: UserRole): UserSession => {
  const roleSettings = DataStorage.get<RolePermissionSetting[]>(STORAGE_KEYS.PERMISSION_ROLE_SETTINGS, []);
  const configuredPermissions = roleSettings.length > 0
    ? roleSettings
      .filter(setting => setting.roleName === role && setting.enabled)
      .map(setting => setting.permissionKey)
    : getDefaultPermissionsForRole(role);
  const session: UserSession = {
    id: account.employeeRecordId,
    userName: account.userName,
    employeeId: account.employeeId,
    name: account.displayName,
    email: account.email,
    role,
    availableRoles: account.roles,
    permissions: getEffectivePermissions({
      id: account.employeeRecordId,
      employeeId: account.employeeId,
      role,
      permissions: configuredPermissions,
      permissionRole: role,
    }, DataStorage.get<UserPermissionGrant[]>(STORAGE_KEYS.PERMISSION_USER_GRANTS, [])),
    permissionRole: role,
    lastLogin: new Date().toISOString(),
  };
  if (role === 'CountryDirector') {
    const directors = DataStorage.get<CountryDirector[]>(STORAGE_KEYS.CDS, []);
    const cd = directors.find(d => d.name === account.displayName);
    if (cd) session.cdId = cd.id;
  }
  return session;
};

type ApiLoginResponse = {
  id: string;
  username: string;
  employeeId: string;
  employeeRecordId?: string;
  countryDirectorId?: string;
  email: string;
  name?: string;
  roles: UserRole[];
  activeRole: UserRole;
  mustChangePassword?: boolean;
  permissions?: string[];
  permissionRole?: UserRole;
  token: string;
};

type EntraLoginConfig = {
  enabled: boolean;
  provider: string;
  startUrl: string;
  redirectUri?: string | null;
};

const buildApiSession = (data: ApiLoginResponse): UserSession => ({
  id: data.employeeRecordId || data.employeeId || data.id,
  userName: data.username,
  employeeId: data.employeeId,
  name: data.name || data.username,
  email: data.email,
  role: data.activeRole,
  availableRoles: data.roles,
  permissions: data.permissions,
  permissionRole: data.permissionRole || data.activeRole,
  cdId: data.countryDirectorId,
  mustChangePassword: data.mustChangePassword,
  lastLogin: new Date().toISOString(),
});

// ─── Session storage (works in both modes) ────────────────────────────────────
const saveSession = (session: UserSession) =>
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));

const loadSession = (): UserSession | null => {
  try {
    // API mode: sessionStorage
    const s = sessionStorage.getItem(SESSION_KEY);
    if (s) return JSON.parse(s) as UserSession;
    // Demo fallback: localStorage
    return DataStorage.get<UserSession | null>(STORAGE_KEYS.AUTH, null);
  } catch { return null; }
};

// ─── Public service ───────────────────────────────────────────────────────────
export const authService = {
  login: async (identifier: string, password = '', requestedRole?: UserRole): Promise<UserSession | null> => {
    let backendConnected = false;
    try {
      backendConnected = await checkBackend();
    } catch {
      return null;
    }

    if (backendConnected) {
      // ── API mode ──
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: identifier, password, requestedRole }),
        });
        if (!res.ok) return null;
        const data = await res.json() as ApiLoginResponse;
        const session = buildApiSession(data);
        clearToken();
        storeToken(data.token);
        saveSession(session);
        return session;
      } catch { return null; }
    }

    if (!isDemoFallbackAllowed()) return null;

    // ── Demo / localStorage mode ──
    DataStorage.ensureUserAccounts();
    const account = findAccount(identifier);
    if (!account || account.status !== 'Active') return null;
    const expectedHash = account.passwordHash.replace(/^sha256:/, '');
    const suppliedHash = await sha256(password);
    if (suppliedHash !== expectedHash) return null;
    const role = requestedRole && account.roles.includes(requestedRole) ? requestedRole : account.primaryRole;
    const session = buildSession(account, role);
    DataStorage.set(STORAGE_KEYS.AUTH, session);
    saveSession(session);
    DataStorage.logAction(session.id, session.name, session.role, 'Login', 'Auth', `Logged in as ${role}`);
    return session;
  },

  getEntraLoginConfig: async (): Promise<EntraLoginConfig> => {
    try {
      if (!(await checkBackend())) return { enabled: false, provider: 'local', startUrl: '/api/auth/entra/start' };
      const res = await fetch('/api/auth/entra/config', { credentials: 'include' });
      if (!res.ok) return { enabled: false, provider: 'local', startUrl: '/api/auth/entra/start' };
      return await res.json() as EntraLoginConfig;
    } catch {
      return { enabled: false, provider: 'local', startUrl: '/api/auth/entra/start' };
    }
  },

  completeEntraLogin: async (): Promise<UserSession | null> => {
    try {
      resetBackendCheck();
      // A callback may follow an earlier session in the same browser tab. Do
      // not let that stale bearer token override the new Entra session cookie.
      clearToken();
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(STORAGE_KEYS.AUTH);
      if (!(await checkBackend())) return null;
      const res = await fetch('/api/auth/me', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) return null;
      const data = await res.json() as ApiLoginResponse;
      const session = buildApiSession(data);
      storeToken(data.token);
      saveSession(session);
      return session;
    } catch {
      return null;
    }
  },

  switchRole: async (role: UserRole): Promise<UserSession | null> => {
    const session = authService.getCurrentUser();
    if (!session || !session.availableRoles.includes(role)) return null;
    let backendConnected = false;
    try {
      backendConnected = await checkBackend();
    } catch {
      return null;
    }
    if (backendConnected) {
      try {
        const res = await fetch('/api/auth/switch-role', {
          method: 'POST',
          headers: getApiHeaders(),
          credentials: 'include',
          body: JSON.stringify({ role }),
        });
        if (!res.ok) return null;
        const data = await res.json() as ApiLoginResponse;
        const next = buildApiSession(data);
        storeToken(data.token);
        saveSession(next);
        return next;
      } catch {
        return null;
      }
    }

    if (!isDemoFallbackAllowed()) return null;

    const next = { ...session, role };
    if (role === 'CountryDirector') {
      const directors = DataStorage.get<CountryDirector[]>(STORAGE_KEYS.CDS, []);
      const cd = directors.find(d => d.name === session.name);
      next.cdId = cd?.id;
    } else {
      delete next.cdId;
    }
    saveSession(next);
    DataStorage.set(STORAGE_KEYS.AUTH, next);
    return next;
  },

  logout: async () => {
    const session = authService.getCurrentUser();
    let backendConnected = false;
    try {
      backendConnected = await checkBackend();
    } catch {
      backendConnected = false;
    }
    if (backendConnected) {
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* ok */ }
      clearToken();
      resetBackendCheck();
    }
    if (session) {
      DataStorage.logAction(session.id, session.name, session.role, 'Logout', 'Auth', 'Logged out');
    }
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(STORAGE_KEYS.AUTH);
  },

  getCurrentUser: (): UserSession | null => loadSession(),

  refreshSession: async (): Promise<UserSession | null> => {
    const session = authService.getCurrentUser();
    if (!session) return null;
    let backendConnected = false;
    try {
      backendConnected = await checkBackend();
    } catch {
      return null;
    }
    if (backendConnected) {
      try {
        const res = await fetch('/api/auth/me', {
          method: 'GET',
          headers: getApiHeaders(),
          credentials: 'include',
        });
        if (!res.ok) return null;
        const data = await res.json() as ApiLoginResponse;
        const next = buildApiSession(data);
        storeToken(data.token);
        saveSession(next);
        return next;
      } catch {
        return null;
      }
    }

    if (!isDemoFallbackAllowed()) return null;
    DataStorage.ensureUserAccounts();
    const account = findAccount(session.userName);
    if (!account || account.status !== 'Active') return null;
    const role = account.roles.includes(session.role) ? session.role : account.primaryRole;
    const next = buildSession(account, role);
    DataStorage.set(STORAGE_KEYS.AUTH, next);
    saveSession(next);
    return next;
  },

  isAuthenticated: (): boolean => !!authService.getCurrentUser(),

  hasRole: (roles: UserRole[]): boolean => {
    const user = authService.getCurrentUser();
    return !!user && roles.includes(user.role);
  },

  getAccountByIdentifier: (identifier: string): UserAccount | undefined => {
    DataStorage.ensureUserAccounts();
    return findAccount(identifier);
  },

  changePassword: async (currentPassword: string, newPassword: string): Promise<boolean> => {
    let backendConnected = false;
    try {
      backendConnected = await checkBackend();
    } catch {
      return false;
    }
    if (backendConnected) {
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: getApiHeaders(),
          credentials: 'include',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        if (!res.ok) return false;
        const session = authService.getCurrentUser();
        if (session) {
          const next = { ...session, mustChangePassword: false };
          saveSession(next);
          DataStorage.set(STORAGE_KEYS.AUTH, next);
        }
        return true;
      } catch {
        return false;
      }
    }

    if (!isDemoFallbackAllowed()) return false;
    DataStorage.ensureUserAccounts();
    const session = authService.getCurrentUser();
    if (!session) return false;
    const account = findAccount(session.userName);
    if (!account || account.status !== 'Active') return false;
    const expectedHash = account.passwordHash.replace(/^sha256:/, '');
    const suppliedHash = await sha256(currentPassword);
    if (suppliedHash !== expectedHash) return false;
    const accounts = DataStorage.get<UserAccount[]>(STORAGE_KEYS.USER_ACCOUNTS, []);
    const nextHash = `sha256:${await sha256(newPassword)}`;
    DataStorage.set(STORAGE_KEYS.USER_ACCOUNTS, accounts.map(item =>
      item.id === account.id ? { ...item, passwordHash: nextHash, mustChangePassword: false } : item
    ));
    const nextSession = { ...session, mustChangePassword: false };
    saveSession(nextSession);
    DataStorage.set(STORAGE_KEYS.AUTH, nextSession);
    DataStorage.logAction(session.id, session.name, session.role, 'Change Password', 'Auth', 'Changed own password');
    return true;
  },
};
