import { useEffect, useMemo, useState } from 'react';
import { Lock, Search, ShieldCheck, SlidersHorizontal, UserPlus } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { cn } from '../../lib/utils';
import { adminService } from '../../services/api';
import { PERMISSION_DEFINITIONS, PROTECTED_PERMISSION_KEYS, SYSTEM_ROLES } from '../../services/permissions';
import { PermissionConfig, PermissionKey, PermissionUserSummary, RolePermissionSetting, UserPermissionGrant, UserRole } from '../../types';

type NoticeState = { type: 'success' | 'warning' | 'danger' | 'info'; message: string };

interface PermissionSettingsProps {
  onNotice: (notice: NoticeState) => void;
}

const moduleOptions = ['All', ...Array.from(new Set(PERMISSION_DEFINITIONS.map(permission => permission.module)))];

const Toggle = ({ checked, disabled, onClick }: { checked: boolean; disabled?: boolean; onClick: () => void }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={cn(
      'relative h-5 w-10 rounded-full transition-colors',
      checked ? 'bg-primary' : 'bg-slate-300',
      disabled && 'cursor-not-allowed opacity-50'
    )}
    title={disabled ? 'Protected core permission' : checked ? 'Enabled' : 'Disabled'}
  >
    <span className={cn(
      'absolute top-1 h-3 w-3 rounded-full bg-white shadow-sm transition-all',
      checked ? 'right-1' : 'left-1'
    )} />
  </button>
);

export const PermissionSettings = ({ onNotice }: PermissionSettingsProps) => {
  const [config, setConfig] = useState<PermissionConfig | null>(null);
  const [moduleFilter, setModuleFilter] = useState('All');
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedPermission, setSelectedPermission] = useState<PermissionKey>('dashboard.view');
  const [savingKey, setSavingKey] = useState('');

  const load = async () => {
    setConfig(await adminService.getPermissionConfig());
  };

  useEffect(() => {
    load();
  }, []);

  const visiblePermissions = useMemo(() => {
    return PERMISSION_DEFINITIONS.filter(permission => moduleFilter === 'All' || permission.module === moduleFilter);
  }, [moduleFilter]);

  const users = config?.users || [];
  const filteredUsers = users.filter(user => {
    const haystack = `${user.displayName} ${user.userName} ${user.employeeId} ${user.email}`.toLowerCase();
    return haystack.includes(userSearch.toLowerCase());
  });
  const selectedUser = users.find(user => user.id === selectedUserId) || filteredUsers[0];
  const userGrants = (config?.userGrants || []).filter(grant => selectedUser && grant.userId === selectedUser.id);
  const roleSettings = config?.rolePermissions || [];

  const isRolePermissionEnabled = (roleName: UserRole, permissionKey: PermissionKey) =>
    roleSettings.find(setting => setting.roleName === roleName && setting.permissionKey === permissionKey)?.enabled ?? false;

  const isLocked = (roleName: UserRole, permissionKey: PermissionKey) =>
    (PROTECTED_PERMISSION_KEYS.has(permissionKey) && roleName !== 'Admin') ||
    (permissionKey === 'permissions.manage' && roleName === 'Admin');

  const updateRolePermission = async (roleName: UserRole, permissionKey: PermissionKey, enabled: boolean) => {
    const key = `${roleName}:${permissionKey}`;
    setSavingKey(key);
    try {
      await adminService.setRolePermission(roleName, permissionKey, enabled);
      setConfig(current => current ? {
        ...current,
        rolePermissions: current.rolePermissions.map(setting =>
          setting.roleName === roleName && setting.permissionKey === permissionKey
            ? { ...setting, enabled, updatedAt: new Date().toISOString() }
            : setting
        ),
      } : current);
      onNotice({ type: 'success', message: `${permissionKey} was ${enabled ? 'enabled' : 'disabled'} for ${roleName}.` });
    } catch (error) {
      onNotice({ type: 'danger', message: error instanceof Error ? error.message : 'Permission change was blocked.' });
    } finally {
      setSavingKey('');
    }
  };

  const grantPermission = async () => {
    if (!selectedUser || !selectedPermission) return;
    setSavingKey(`grant:${selectedUser.id}:${selectedPermission}`);
    try {
      const grant = await adminService.grantUserPermission(selectedUser.id, selectedPermission);
      setConfig(current => current ? {
        ...current,
        userGrants: [grant, ...current.userGrants.filter(item => item.id !== grant.id)],
      } : current);
      onNotice({ type: 'success', message: `${selectedPermission} was granted to ${selectedUser.displayName}.` });
    } catch (error) {
      onNotice({ type: 'danger', message: error instanceof Error ? error.message : 'User grant was blocked.' });
    } finally {
      setSavingKey('');
    }
  };

  const revokeGrant = async (grant: UserPermissionGrant) => {
    setSavingKey(`revoke:${grant.id}`);
    await adminService.deleteUserPermissionGrant(grant.id);
    setConfig(current => current ? {
      ...current,
      userGrants: current.userGrants.filter(item => item.id !== grant.id),
    } : current);
    setSavingKey('');
    onNotice({ type: 'success', message: `${grant.permissionKey} was removed from ${grant.displayName || grant.userName || 'the user'}.` });
  };

  const previewPermissions = (user: PermissionUserSummary | undefined) => {
    if (!user) return [];
    const baseline = new Set<PermissionKey>();
    user.roles.forEach(role => {
      roleSettings
        .filter(setting => setting.roleName === role && setting.enabled)
        .forEach(setting => baseline.add(setting.permissionKey));
    });
    (config?.userGrants || [])
      .filter(grant => grant.userId === user.id)
      .forEach(grant => baseline.add(grant.permissionKey));
    return PERMISSION_DEFINITIONS.filter(permission => baseline.has(permission.key));
  };

  if (!config) {
    return (
      <div className="bg-white border border-border-light rounded-3xl p-8 shadow-sm">
        <p className="text-sm text-slate-500 font-medium">Loading permission settings...</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-border-light rounded-3xl p-8 shadow-sm space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5 border-b border-slate-100 pb-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-heading">Permission Settings</h3>
            <p className="text-xs text-body/60 font-medium mt-1 max-w-2xl">
              Configure role defaults and grant extra user access without code changes. Protected core permissions stay locked to prevent accidental security drift.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {moduleOptions.map(module => (
            <button
              key={module}
              onClick={() => setModuleFilter(module)}
              className={cn(
                'rounded-lg border px-3 py-2 text-[10px] font-bold uppercase tracking-widest transition-colors',
                moduleFilter === module
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-primary/40'
              )}
            >
              {module}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Role Permission Matrix</p>
      <div className="max-h-[640px] overflow-auto rounded-2xl border border-slate-100">
        <table className="w-full min-w-[1120px] text-left">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              <th className="sticky left-0 z-20 w-[360px] bg-slate-50 px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">Permission</th>
              {SYSTEM_ROLES.map(role => (
                <th key={role} className="w-[120px] px-3 py-3 text-center text-[10px] font-bold uppercase tracking-widest text-slate-400">{role}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visiblePermissions.map(permission => (
              <tr key={permission.key} className="align-top">
                <td className="sticky left-0 z-[1] bg-white px-5 py-4 shadow-[1px_0_0_0_rgba(226,232,240,0.75)]">
                  <div className="flex items-start gap-3">
                    {permission.protected ? <Lock size={14} className="mt-0.5 text-primary" /> : <SlidersHorizontal size={14} className="mt-0.5 text-slate-300" />}
                    <div>
                      <p className="text-xs font-bold text-heading">{permission.label}</p>
                      <p className="text-[10px] font-mono text-primary mt-1">{permission.key}</p>
                      <p className="text-[10px] text-slate-500 font-medium leading-relaxed mt-1 max-w-lg">{permission.description}</p>
                    </div>
                  </div>
                </td>
                {SYSTEM_ROLES.map(role => {
                  const checked = isRolePermissionEnabled(role, permission.key);
                  const locked = isLocked(role, permission.key);
                  return (
                    <td key={role} className="px-3 py-4 text-center">
                      <Toggle
                        checked={checked}
                        disabled={locked || savingKey === `${role}:${permission.key}`}
                        onClick={() => updateRolePermission(role, permission.key, !checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5 space-y-4">
          <div>
            <h4 className="text-sm font-bold text-heading">User Exceptions</h4>
            <p className="text-[10px] text-slate-500 font-medium mt-1">Additive grants only. Baseline role permissions are not removed per user in this version.</p>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder="Search user"
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-xs outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {filteredUsers.slice(0, 50).map(user => (
              <button
                key={user.id}
                onClick={() => setSelectedUserId(user.id)}
                className={cn(
                  'w-full rounded-xl border p-3 text-left transition-colors',
                  selectedUser?.id === user.id ? 'border-primary bg-white shadow-sm' : 'border-slate-100 bg-white hover:border-primary/30'
                )}
              >
                <p className="text-xs font-bold text-heading">{user.displayName}</p>
                <p className="text-[10px] text-slate-500 font-medium">{user.employeeId} / {user.userName}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {user.roles.map(role => (
                    <span key={role}>
                      <Badge variant="neutral" className="text-[9px]">{role}</Badge>
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-100 p-5 space-y-5">
          {selectedUser ? (
            <>
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-bold text-heading">{selectedUser.displayName}</h4>
                  <p className="text-[10px] text-slate-500 font-medium">{selectedUser.email}</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 min-w-[320px]">
                  <select
                    value={selectedPermission}
                    onChange={(event) => setSelectedPermission(event.target.value)}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    {PERMISSION_DEFINITIONS.map(permission => (
                      <option key={permission.key} value={permission.key}>{permission.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={grantPermission}
                    disabled={savingKey.startsWith('grant:')}
                    className="btn-primary px-4 py-2.5 text-xs flex items-center justify-center gap-2"
                  >
                    <UserPlus size={14} /> Grant
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Extra Grants</p>
                  <div className="space-y-2">
                    {userGrants.length === 0 && <p className="rounded-xl bg-slate-50 p-4 text-xs text-slate-500 font-medium">No user-specific grants.</p>}
                    {userGrants.map(grant => (
                      <div key={grant.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
                        <div>
                          <p className="text-xs font-bold text-heading">{PERMISSION_DEFINITIONS.find(permission => permission.key === grant.permissionKey)?.label || grant.permissionKey}</p>
                          <p className="text-[10px] font-mono text-slate-500">{grant.permissionKey}</p>
                        </div>
                        <button
                          onClick={() => revokeGrant(grant)}
                          disabled={savingKey === `revoke:${grant.id}`}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-danger"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3">Access Preview</p>
                  <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-100 divide-y divide-slate-100">
                    {previewPermissions(selectedUser).map(permission => (
                      <div key={permission.key} className="px-3 py-2.5">
                        <p className="text-xs font-bold text-heading">{permission.label}</p>
                        <p className="text-[10px] text-slate-500">{permission.module}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500 font-medium">No users found.</p>
          )}
        </div>
      </div>
    </div>
  );
};
