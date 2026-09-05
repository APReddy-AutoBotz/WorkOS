import React, { useState, useEffect } from 'react';
import { Save, X, Info, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Employee, CountryDirector, RoleDefinition, CatalogItem } from '../../types';
import { employeeService, adminService } from '../../services/api';
import { EMPLOYEE_STATUSES } from '../../constants/statuses';
import { validateEmployeeHierarchy } from '../../services/orgChart';

import { productConfig } from '../../config/productConfig';
import { term, termPluralTitle, termTitle } from '../../config/terminology';
const BUSINESS_UNITS = ['DACH', 'South Europe', `${productConfig.organizationName} AI`, 'NEXUS', 'Other'];
const REGION_OPTIONS = ['India', 'Sri Lanka', 'USA', 'United Kingdom', 'Turkey', 'Switzerland', 'Spain', 'Germany', 'France', 'Italy', 'Egypt', 'DACH', 'South Europe', `${productConfig.organizationName} AI`, 'NEXUS', 'Other'];

export const EmployeeForm = ({ employee, onClose, onSave }: { employee?: Employee; onClose: () => void; onSave: () => void }) => {
  const [formData, setFormData] = useState<Partial<Employee>>({
    name: '',
    employeeId: '',
    email: '',
    designation: 'Senior Consultant',
    department: 'Digital Transformation',
    country: 'United Kingdom',
    region: 'United Kingdom',
    businessUnit: 'Other',
    status: 'Active',
    primaryCountryDirectorId: '',
    mappedCountryDirectorIds: [],
    reportingManagerId: '',
    standardWeeklyHours: 40,
    capacityType: 'Delivery',
    contractType: 'Permanent',
    plannedUtilization: 0,
    actualUtilization: 0,
    activeProjectCount: 0,
    ...employee
  });

  const [cds, setCds] = useState<CountryDirector[]>([]);
  const [roleDefinitions, setRoleDefinitions] = useState<RoleDefinition[]>([]);
  const [departments, setDepartments] = useState<CatalogItem[]>([]);
  const [countries, setCountries] = useState<CatalogItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>('');

  useEffect(() => {
    let mounted = true;
    const loadOptions = async () => {
      try {
        const [directorData, roleData, departmentData, countryData, employeeData] = await Promise.all([
          adminService.getCountryDirectors(),
          adminService.getRoleDefinitions(),
          adminService.getDepartments(),
          adminService.getCountries(),
          employeeService.getAll(),
        ]);
        if (!mounted) return;
        setCds(directorData);
        setRoleDefinitions(roleData);
        setDepartments(departmentData);
        setCountries(countryData);
        setEmployees(employeeData);
      } catch (error) {
        console.error('Failed to load employee form options', error);
      }
    };
    loadOptions();
    return () => { mounted = false; };
  }, []);

  const departmentOptions = Array.from(new Set([
    ...departments.map(item => item.name),
    formData.department || '',
  ].filter(Boolean)));
  const countryOptions = Array.from(new Set([
    ...countries.map(item => item.name),
    formData.country || '',
  ].filter(Boolean)));

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.name) newErrors.name = 'Name is required';
    if (!formData.employeeId) newErrors.employeeId = `${termTitle('employee')} ID is required`;
    if (!formData.email) newErrors.email = 'Email is required';
    if (!formData.primaryCountryDirectorId) newErrors.cd = 'Primary Director is required';
    if (!formData.standardWeeklyHours || formData.standardWeeklyHours < 1) newErrors.standardWeeklyHours = 'Standard weekly hours are required';
    const candidate = { id: employee?.id || 'new-employee-preview', ...formData } as Employee;
    const hierarchy = validateEmployeeHierarchy(employees, candidate);
    if (!hierarchy.valid) newErrors.reportingManagerId = hierarchy.errors.join(' ');
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!validate()) return;

    setLoading(true);
    try {
      const dataToSave: Employee = {
        id: employee?.id || `e-${Date.now()}`,
        ...formData as Employee
      };
      dataToSave.mappedCountryDirectorIds = Array.from(new Set([
        dataToSave.primaryCountryDirectorId,
        ...(dataToSave.mappedCountryDirectorIds || [])
      ].filter(Boolean)));
      await employeeService.save(dataToSave);
      onSave();
      onClose();
    } catch (error) {
      console.error(error);
      setFormError(error instanceof Error ? error.message : `${termTitle('employee')} could not be saved.`);
    } finally {
      setLoading(false);
    }
  };

  const availableManagers = employees
    .filter(item => item.id !== employee?.id && item.status !== 'Exited')
    .filter(item => validateEmployeeHierarchy(employees, { ...(employee || formData), id: employee?.id || 'new-employee-preview', reportingManagerId: item.id } as Employee).valid)
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggleCDMapping = (id: string) => {
    const current = formData.mappedCountryDirectorIds || [];
    if (current.includes(id)) {
      setFormData({ ...formData, mappedCountryDirectorIds: current.filter(cid => cid !== id) });
    } else {
      setFormData({ ...formData, mappedCountryDirectorIds: [...current, id] });
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl border border-border-light overflow-hidden max-w-2xl w-full mx-auto">
      <div className="px-8 py-6 border-b border-border-light flex items-center justify-between bg-gray-50/50">
        <div>
          <h3 className="text-xl font-bold text-heading tracking-tight">{employee ? `Edit ${termTitle('employee')}` : `Onboard ${termTitle('employee')}`}</h3>
          <p className="text-xs text-body opacity-60 font-medium">Register or update a resource in the global directory.</p>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
          <X size={20} />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-8 space-y-10 max-h-[70vh] overflow-y-auto custom-scrollbar">
        {/* Section: General Info */}
        <section className="space-y-6">
          <div className="flex items-center gap-2 pb-2 border-b border-gray-50">
             <div className="w-1.5 h-4 bg-primary rounded-full"></div>
             <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">General Information</h4>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Full Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. John Doe"
                className={cn("w-full bg-white border rounded-xl px-4 py-2.5 text-xs outline-none transition-all shadow-sm", errors.name ? "border-danger" : "border-border-light focus:border-primary")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">{termTitle('employee')} ID</label>
              <input
                type="text"
                value={formData.employeeId}
                onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })}
                placeholder="BL-XXX"
                className={cn("w-full bg-slate-50 border rounded-xl px-4 py-2.5 text-xs outline-none transition-all shadow-sm font-mono", errors.employeeId ? "border-danger" : "border-slate-200 focus:border-primary")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Work Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="john.doe@example.test"
                className={cn("w-full bg-white border rounded-xl px-4 py-2.5 text-xs outline-none transition-all shadow-sm", errors.email ? "border-danger" : "border-border-light focus:border-primary")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Designation</label>
              <select
                value={formData.designation}
                onChange={(e) => setFormData({ ...formData, designation: e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                {roleDefinitions.map(role => <option key={role.id}>{role.name}</option>)}
                <option>Business Analyst + Project Manager</option>
                <option>RPA Developer + Solution Architect</option>
                <option>Support Team + Operations Executive</option>
                <option>{`${productConfig.terminology.regionalOwner}`}</option>
                <option>System Administrator</option>
                <option>HR Manager</option>
              </select>
            </div>
          </div>
        </section>

        {/* Section: Reporting & Mapping */}
        <section className="space-y-6">
          <div className="flex items-center gap-2 pb-2 border-b border-gray-50">
             <div className="w-1.5 h-4 bg-primary rounded-full"></div>
             <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Reporting & Mapping</h4>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Primary Department</label>
              <select
                value={formData.department}
                onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                {departmentOptions.map(department => <option key={department}>{department}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Base Country</label>
              <select
                value={formData.country}
                onChange={(e) => setFormData({ ...formData, country: e.target.value, region: formData.region || e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                {countryOptions.map(country => <option key={country}>{country}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">{termTitle('region')}</label>
              <select
                value={formData.region || formData.country || ''}
                onChange={(e) => setFormData({ ...formData, region: e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                {Array.from(new Set([...(REGION_OPTIONS), formData.region || '', formData.country || ''].filter(Boolean))).map(region => <option key={region}>{region}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">{termTitle('businessUnit')}</label>
              <select
                value={formData.businessUnit || 'Other'}
                onChange={(e) => setFormData({ ...formData, businessUnit: e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                {Array.from(new Set([...(BUSINESS_UNITS), formData.businessUnit || ''].filter(Boolean))).map(unit => <option key={unit}>{unit}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-3">
             <div className="flex items-center justify-between">
               <label className="text-xs font-bold text-heading uppercase tracking-wider">{`Multi-${productConfig.terminology.regionalOwner} Mapping`}</label>
               <span className="text-[10px] text-primary font-bold">Multiple Allowed</span>
             </div>
             <div className="grid grid-cols-2 gap-3">
                {cds.map(cd => (
                  <label key={cd.id} className={cn(
                    "flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-all group",
                    formData.mappedCountryDirectorIds?.includes(cd.id) ? "border-primary bg-orange-50/30" : "border-border-light hover:bg-slate-50"
                  )}>
                    <input
                      type="checkbox"
                      checked={formData.mappedCountryDirectorIds?.includes(cd.id)}
                      onChange={() => toggleCDMapping(cd.id)}
                      className="w-4 h-4 rounded text-primary focus:ring-primary border-gray-300"
                    />
                    <div className="flex flex-col">
                      <span className={cn("text-xs font-bold transition-colors", formData.mappedCountryDirectorIds?.includes(cd.id) ? "text-primary" : "text-slate-dark")}>
                        {cd.name}
                      </span>
                      <span className="text-[9px] text-gray-400 font-mono uppercase">{cd.region}</span>
                    </div>
                  </label>
                ))}
             </div>
            <div className="space-y-1 mt-4">
                <label className="text-xs font-bold text-heading uppercase tracking-wider">{`Primary ${productConfig.terminology.regionalOwner}`}</label>
                <select
                  value={formData.primaryCountryDirectorId}
                  onChange={(e) => setFormData({ ...formData, primaryCountryDirectorId: e.target.value })}
                  className={cn("w-full bg-white border rounded-xl px-4 py-2.5 text-xs outline-none transition-all cursor-pointer shadow-sm", errors.cd ? "border-danger" : "border-border-light focus:border-primary")}
                >
                  <option value="">Select Primary Director</option>
                  {cds.map(cd => <option key={cd.id} value={cd.id}>{cd.name}</option>)}
                </select>
             </div>
             <div className="space-y-1">
                <label className="text-xs font-bold text-heading uppercase tracking-wider">Reporting {termTitle('manager')}</label>
                <select
                  value={formData.reportingManagerId || ''}
                  onChange={(e) => setFormData({ ...formData, reportingManagerId: e.target.value || undefined })}
                  className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs outline-none transition-all cursor-pointer shadow-sm focus:border-primary"
                >
                  <option value="">Unassigned</option>
                  {availableManagers.map(item => <option key={item.id} value={item.id}>{item.name} ({item.employeeId})</option>)}
                </select>
                {errors.reportingManagerId && <p className="text-[10px] text-danger font-bold mt-1">{errors.reportingManagerId}</p>}
             </div>
             <div className="flex items-start gap-2 p-3 bg-bg-secondary rounded-xl border border-border-light mt-4">
                <Info size={14} className="text-primary mt-0.5 shrink-0" />
                <p className="text-[10px] text-body/70 leading-relaxed font-medium">
                  Mapping a {term('employee')} to multiple {termPluralTitle('regionalOwner').toLowerCase()} allows them to appear in all relevant organizational filtered views and utilization reports.
                </p>
             </div>
          </div>
        </section>

        {/* Section: Operational */}
        <section className="space-y-6">
          <div className="flex items-center gap-2 pb-2 border-b border-gray-50">
             <div className="w-1.5 h-4 bg-primary rounded-full"></div>
             <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Operational Status</h4>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Employment Status</label>
              <div className="flex gap-2">
                 {EMPLOYEE_STATUSES.map(status => (
                   <button
                     key={status}
                     type="button"
                     onClick={() => setFormData({ ...formData, status })}
                     className={cn(
                      "flex-1 py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg border transition-all",
                      formData.status === status ? "bg-white border-primary text-primary" : "bg-bg-secondary border-border-light text-gray-400"
                    )}
                   >
                     {status}
                   </button>
                 ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Utilization Plan</label>
              <div className="w-full bg-slate-50 border border-border-light rounded-xl px-4 py-2.5 text-xs text-slate-500 font-bold">
                Calculated from active allocations
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Standard Weekly Hours</label>
              <input
                type="number"
                min={1}
                max={168}
                value={formData.standardWeeklyHours || 40}
                onChange={(e) => setFormData({ ...formData, standardWeeklyHours: Number(e.target.value) })}
                className={cn("w-full bg-white border rounded-xl px-4 py-2.5 text-xs outline-none transition-all shadow-sm", errors.standardWeeklyHours ? "border-danger" : "border-border-light focus:border-primary")}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Capacity Type</label>
              <select
                value={formData.capacityType || 'Delivery'}
                onChange={(e) => setFormData({ ...formData, capacityType: e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                <option>Delivery</option>
                <option>Governance</option>
                <option>Shared</option>
                <option>NonDelivery</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Contract Type</label>
              <select
                value={formData.contractType || 'Permanent'}
                onChange={(e) => setFormData({ ...formData, contractType: e.target.value })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all cursor-pointer shadow-sm"
              >
                <option>Permanent</option>
                <option>Contractor</option>
                <option>FixedTerm</option>
                <option>Intern</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Joining Date</label>
              <input
                type="date"
                value={formData.joiningDate || ''}
                onChange={(e) => setFormData({ ...formData, joiningDate: e.target.value || undefined })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs outline-none transition-all shadow-sm focus:border-primary"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-heading uppercase tracking-wider">Exit Date</label>
              <input
                type="date"
                value={formData.exitDate || ''}
                onChange={(e) => setFormData({ ...formData, exitDate: e.target.value || undefined })}
                className="w-full bg-white border border-border-light rounded-xl px-4 py-2.5 text-xs outline-none transition-all shadow-sm focus:border-primary"
              />
            </div>
          </div>
        </section>
      </form>

      <div className="px-8 py-6 border-t border-border-light bg-gray-50/80 flex items-center justify-end gap-4">
        {formError && <p className="mr-auto text-xs font-bold text-danger">{formError}</p>}
        <button type="button" onClick={onClose} className="text-xs font-bold uppercase tracking-widest text-slate-dark hover:text-primary transition-colors">Cancel</button>
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="btn-primary flex items-center gap-2 px-10 py-3 shadow-xl shadow-primary/20"
        >
          {loading ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
          {employee ? 'Save Changes' : 'Update Registry'}
        </button>
      </div>
    </div>
  );
};
