import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Maximize2, Minus, Plus, SearchX, Users } from 'lucide-react';
import { Allocation, Employee } from '../../types';
import { Badge } from '../ui/Badge';
import { cn } from '../../lib/utils';
import { buildOrgTree } from '../../services/orgChart';
import { isUtilizationEligibleEmployee } from '../../services/calculations';

import { productConfig } from '../../config/productConfig';
import { termPluralTitle, termTitle } from '../../config/terminology';
interface OrgChartViewProps {
  employees: Employee[];
  allocations: Allocation[];
  allEmployees: Employee[];
}

interface OrgUnitGroup {
  id: string;
  label: string;
  employees: Employee[];
  leaders: Employee[];
  members: Employee[];
}

const UNIT_ORDER = [
  'India',
  'Sri Lanka',
  'USA',
  `${productConfig.organizationName} AI`,
  'United Kingdom',
  'Turkey',
  'DACH',
  'South Europe',
  'NEXUS',
  'Switzerland',
  'Spain',
  'Germany',
  'France',
  'Italy',
  'Egypt',
  'Other',
];

const executivePattern = /(ceo|group leadership|head of operations)/i;
const orgUnitInchargePattern = /(country director|regional lead|business unit lead|company director)/i;
const businessUnitGroups = new Set(['DACH', 'South Europe', `${productConfig.organizationName} AI`, 'NEXUS']);

const getDisplayUnit = (employee: Employee) => {
  if (employee.businessUnit && businessUnitGroups.has(employee.businessUnit)) return employee.businessUnit;
  return employee.region && businessUnitGroups.has(employee.region) ? employee.region : employee.country || employee.region || 'Other';
};

const compactTitle = (designation: string) => {
  if (/ceo/i.test(designation)) return 'CEO';
  if (/head of operations/i.test(designation)) return 'Head of Operations';
  if (/country director/i.test(designation)) return `${productConfig.terminology.regionalOwner}`;
  if (/regional lead/i.test(designation)) return `${termTitle('region')} ${termTitle('teamLead')}`;
  if (/business unit lead|company director/i.test(designation)) return `${termTitle('businessUnit')} ${termTitle('teamLead')}`;
  return designation;
};

const nameTone = (employee: Employee, utilizationEligible: boolean) => {
  if (employee.status === 'Exited') return 'text-slate-400 line-through decoration-slate-300';
  if (employee.status === 'On Leave') return 'text-warning';
  if (!utilizationEligible) return 'text-heading';
  if (employee.plannedUtilization <= 20) return 'text-success';
  return 'text-[#164d86]';
};

const makeGroupId = (label: string) => `org-unit-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const isOrgUnitIncharge = (employee: Employee) => orgUnitInchargePattern.test(employee.designation);

const inchargePriority = (employee: Employee) => {
  if (/country director/i.test(employee.designation)) return 0;
  if (/regional lead/i.test(employee.designation)) return 1;
  if (/business unit lead|company director/i.test(employee.designation)) return 2;
  return 3;
};

const sortEmployees = (items: Employee[]) => [...items].sort((a, b) => {
  const aLead = isOrgUnitIncharge(a) ? 0 : 1;
  const bLead = isOrgUnitIncharge(b) ? 0 : 1;
  return aLead - bLead || inchargePriority(a) - inchargePriority(b) || a.name.localeCompare(b.name);
});

const PersonNode = ({
  employee,
  size = 'md',
}: {
  employee: Employee;
  size?: 'sm' | 'md' | 'lg';
}) => (
  <Link
    to={`/employees/${employee.id}`}
    className={cn(
      'block rounded-lg border bg-white text-center shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md',
      size === 'lg' ? 'w-[190px] px-4 py-3' : size === 'md' ? 'w-[180px] px-3 py-2.5' : 'w-full px-2 py-2'
    )}
    title={`Open ${employee.name}`}
    data-employee-id={employee.id}
  >
    <p className={cn('font-black text-heading truncate', size === 'lg' ? 'text-sm' : 'text-xs')}>{employee.name}</p>
    <p className="text-[10px] font-bold text-primary truncate mt-0.5">{compactTitle(employee.designation)}</p>
  </Link>
);

const PersonLine: FC<{
  employee: Employee;
  allocations: Allocation[];
}> = ({
  employee,
  allocations,
}) => {
  const utilizationEligible = isUtilizationEligibleEmployee(employee, allocations);
  return (
    <Link
      to={`/employees/${employee.id}`}
      className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-white hover:shadow-sm transition-all"
      title={`Open ${employee.name}`}
      data-employee-id={employee.id}
    >
      <span className={cn('truncate text-[11px] font-bold leading-tight group-hover:text-primary', nameTone(employee, utilizationEligible))}>
        {employee.name}
      </span>
      <span className="shrink-0 text-[9px] font-black text-slate-400 tabular-nums">
        {utilizationEligible ? `${employee.plannedUtilization}%` : 'Gov'}
      </span>
    </Link>
  );
};

const OrgUnitPanel = ({
  group,
  allocations,
  collapsed,
  onToggle,
}: {
  group: OrgUnitGroup;
  allocations: Allocation[];
  collapsed: boolean;
  onToggle: () => void;
}) => {
  const shownMembers = collapsed ? [] : group.members;
  const inactiveCount = group.employees.filter(employee => employee.status === 'Exited').length;

  return (
    <section className="w-[218px] rounded-lg bg-[#ededee] border border-slate-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-3 text-center hover:bg-slate-100 transition-colors"
        title={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
      >
        <div className="flex items-center justify-center gap-1.5">
          <p className="text-[11px] font-black text-primary truncate">{group.label}</p>
          {collapsed ? <ChevronRight size={13} className="text-slate-400" /> : <ChevronDown size={13} className="text-slate-400" />}
        </div>
        {group.leaders.map(leader => (
          <div key={leader.id} className="mt-1">
            <p className="text-xs font-black text-heading truncate">{leader.name}</p>
            <p className="text-[10px] font-bold text-heading/80 truncate">{compactTitle(leader.designation)}</p>
          </div>
        ))}
        {group.leaders.length === 0 && (
          <p className="mt-1 text-[10px] font-bold text-slate-500">No incharge assigned</p>
        )}
      </button>

      {!collapsed && (
        <div className="border-t border-white/80 px-2 py-2">
          <div className="flex items-center justify-between px-1 pb-1.5">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">
              Team
            </span>
            <span className="text-[9px] font-black text-slate-500">
              {group.employees.length} people{inactiveCount ? ` / ${inactiveCount} inactive` : ''}
            </span>
          </div>
          <div className="max-h-[285px] overflow-y-auto custom-scrollbar pr-1">
            {shownMembers.length === 0 ? (
              <p className="px-2 py-3 text-[10px] font-bold text-slate-400 text-center">No matching employees</p>
            ) : (
              shownMembers.map(employee => (
                <PersonLine key={employee.id} employee={employee} allocations={allocations} />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export const OrgChartView = ({ employees, allocations, allEmployees }: OrgChartViewProps) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(0.92);
  const tree = useMemo(() => buildOrgTree(employees), [employees]);

  const allById = useMemo(() => new Map(allEmployees.map(employee => [employee.id, employee])), [allEmployees]);
  const ceo = useMemo(() =>
    allEmployees.find(employee => /ceo|group leadership/i.test(`${employee.designation} ${employee.department}`)) ||
    employees.find(employee => !employee.reportingManagerId),
  [allEmployees, employees]);
  const headOfOps = useMemo(() =>
    allEmployees.find(employee => executivePattern.test(`${employee.designation} ${employee.department}`) && /head of operations/i.test(employee.designation)),
  [allEmployees]);

  const groupedUnits = useMemo(() => {
    const groups = new Map<string, Employee[]>();
    const visibleIds = new Set(employees.map(employee => employee.id));
    const excludedLeadershipIds = new Set([ceo?.id, headOfOps?.id].filter(Boolean));

    for (const employee of employees) {
      if (excludedLeadershipIds.has(employee.id)) continue;
      const label = getDisplayUnit(employee);
      groups.set(label, [...(groups.get(label) || []), employee]);
    }

    return Array.from(groups.entries())
      .map(([label, groupEmployees]) => {
        const sorted = sortEmployees(groupEmployees);
        const incharges = sorted.filter(isOrgUnitIncharge);
        const leaders = incharges.slice(0, 1);
        const inchargeIds = new Set(incharges.map(employee => employee.id));
        const members = sorted.filter(employee => !inchargeIds.has(employee.id));
        const connectedMembers = members.filter(employee => !employee.reportingManagerId || visibleIds.has(employee.reportingManagerId) || allById.has(employee.reportingManagerId));
        return {
          id: makeGroupId(label),
          label,
          employees: sorted,
          leaders,
          members: connectedMembers,
        };
      })
      .sort((a, b) => {
        const ai = UNIT_ORDER.indexOf(a.label);
        const bi = UNIT_ORDER.indexOf(b.label);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.label.localeCompare(b.label);
      });
  }, [employees, allById, ceo?.id, headOfOps?.id]);

  const toggle = (id: string) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const collapseGroups = () => setCollapsed(new Set(groupedUnits.map(group => group.id)));

  return (
    <div className="space-y-5">
      <div className="dashboard-card p-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-orange-50 text-primary flex items-center justify-center border border-primary/10">
              <Users size={18} />
            </div>
            <div>
              <h3 className="text-base font-black text-heading">Organization Chart</h3>
              <p className="text-xs text-body/60 font-medium">
                Tree generated from {termTitle('employee')} Master reporting {termPluralTitle('manager').toLowerCase()}, countries, {termPluralTitle('region').toLowerCase()}, {termPluralTitle('businessUnit').toLowerCase()}, and utilization data.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setZoom(value => Math.max(0.76, value - 0.05))} className="btn-secondary px-3 py-2" title="Zoom out" aria-label="Zoom out">
              <Minus size={14} />
            </button>
            <button onClick={() => setZoom(0.86)} className="btn-secondary px-3 py-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest">
              <Maximize2 size={14} /> Fit to Screen
            </button>
            <button onClick={() => setZoom(value => Math.min(1, value + 0.05))} className="btn-secondary px-3 py-2" title="Zoom in" aria-label="Zoom in">
              <Plus size={14} />
            </button>
            <button onClick={collapseGroups} className="btn-secondary px-3 py-2 text-[10px] font-bold uppercase tracking-widest">
              Collapse Branches
            </button>
            <button onClick={() => setCollapsed(new Set())} className="btn-secondary px-3 py-2 text-[10px] font-bold uppercase tracking-widest">
              Expand All
            </button>
          </div>
        </div>

        {(tree.cycles.length > 0 || tree.invalidManagerIds.length > 0) && (
          <div className="mt-4 rounded-lg border border-warning/20 bg-warning-bg px-4 py-3">
            <p className="text-xs font-black text-warning">Hierarchy integrity attention needed</p>
            <p className="text-[10px] text-body/70 font-medium mt-1">
              {tree.cycles.length} circular chain{tree.cycles.length === 1 ? '' : 's'} and {tree.invalidManagerIds.length} invalid manager reference{tree.invalidManagerIds.length === 1 ? '' : 's'} were moved to Unassigned.
            </p>
          </div>
        )}
      </div>

      {employees.length === 0 ? (
        <div className="dashboard-card py-16 text-center">
          <SearchX className="mx-auto text-slate-300" size={32} />
          <p className="text-sm font-bold text-heading mt-3">No employees match the current org chart filters.</p>
        </div>
      ) : (
        <div className="dashboard-card overflow-hidden">
          <div className="overflow-auto custom-scrollbar bg-white p-6">
            <div
              className="origin-top-left min-w-[1180px] transition-transform"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            >
              <div className="relative mx-auto pb-8">
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <p className="text-[10px] font-bold text-slate-400">Generated from {termTitle('employee')} Master</p>
                    <h2 className="text-xl font-black text-primary">{`Org Chart ${productConfig.organizationName} Group`}</h2>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Visible Records</p>
                    <p className="text-sm font-black text-heading">{employees.length} employees</p>
                  </div>
                </div>

                <div className="flex justify-center">
                  {ceo ? (
                    <PersonNode employee={ceo} size="lg" />
                  ) : (
                    <div className="w-[190px] rounded-lg bg-heading px-4 py-3 text-center shadow-sm">
                      <p className="text-sm font-black text-white">{`${productConfig.organizationName} Group`}</p>
                      <p className="text-[10px] font-bold text-white/70">Root</p>
                    </div>
                  )}
                </div>

                <div className="mx-auto h-10 w-px bg-slate-300" />

                <div className="relative mb-10">
                  <div className="absolute left-[12%] right-[12%] top-1/2 h-px bg-slate-300" />
                  <div className="relative flex justify-center gap-32">
                    {headOfOps && <PersonNode employee={headOfOps} />}
                    <div className="w-[180px] rounded-lg border border-slate-200 bg-[#ededee] px-3 py-2.5 text-center shadow-sm">
                      <p className="text-xs font-black text-primary">Countries / {termPluralTitle('region')} / {termPluralTitle('businessUnit')}</p>
                      <p className="text-[10px] font-bold text-heading/70">{groupedUnits.length} operating groups</p>
                    </div>
                  </div>
                </div>

                <div className="relative">
                  <div className="absolute left-[7%] right-[7%] -top-5 h-px bg-slate-300" />
                  <div className="absolute left-1/2 -top-10 h-10 w-px bg-slate-300" />
                  <div className="grid grid-cols-5 gap-3 items-start">
                    {groupedUnits.map(group => (
                      <div key={group.id} className="relative pt-5">
                        <div className="absolute left-1/2 top-0 h-5 w-px bg-slate-300" />
                        <OrgUnitPanel
                          group={group}
                          allocations={allocations}
                          collapsed={collapsed.has(group.id)}
                          onToggle={() => toggle(group.id)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tree.unassigned.length > 0 && (
        <div className="dashboard-card p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-black text-heading">Unassigned / Missing Manager</h3>
              <p className="text-xs text-body/60 font-medium">Employees without a valid reporting manager in the current filtered dataset.</p>
            </div>
            <Badge variant="warning">{tree.unassigned.length} Records</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {tree.unassigned.map(node => (
              <PersonLine key={node.employee.id} employee={node.employee} allocations={allocations} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
