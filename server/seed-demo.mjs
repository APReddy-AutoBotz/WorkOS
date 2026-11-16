import {assertLegacyProjectMutationAllowed} from './modules/commercial-drafting/project-mutation.mjs';
import 'dotenv/config';
import crypto from 'node:crypto';
import pg from 'pg';
import {databaseConnectionOptions} from './database-connection.mjs';
import {
  DEFAULT_COUNTRIES,
  DEFAULT_DEPARTMENTS,
  DEFAULT_INDUSTRIES,
  createDefaultCatalog,
  generateDemoDataset,
} from '../src/services/demoData.ts';

const { Pool } = pg;
const DEMO_ORGANIZATION_ID = 'org-default';
const DEMO_LEGAL_ENTITY_ID = 'legal-default';

const reset = process.argv.includes('--reset') || process.env.RESET_DEMO_DATA === 'true';
if (process.env.NODE_ENV === 'production' || process.env.APP_MODE === 'production') {
  throw new Error('Demo seeding is prohibited in production.');
}
const password = String(process.env.DEMO_SEED_PASSWORD || '');
if (!password) throw new Error('DEMO_SEED_PASSWORD is required for explicit non-production demo seeding.');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to seed demo data.');
  process.exit(1);
}

const pool = new Pool(databaseConnectionOptions({databaseUrl: process.env.DATABASE_URL,
  sslMode: process.env.PGSSLMODE || 'disable', sslRootCert: process.env.PGSSLROOTCERT}));

const scryptHash = async (value) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(value, salt, 64, (error, result) => error ? reject(error) : resolve(result.toString('hex')));
  });
  return `scrypt$${salt}$${key}`;
};

const rolesForEmployee = (employee) => {
  if (employee.employeeId === 'ADMIN-1') return ['Admin'];
  if (employee.employeeId === 'HR-1') return ['HR'];
  if (employee.employeeId.startsWith('CD-')) return ['CountryDirector'];
  if (employee.employeeId === 'PM-1') return ['ProjectManager', 'TeamLead', 'Employee'];
  if (employee.employeeId.startsWith('PM-')) return ['ProjectManager', 'Employee'];
  return ['Employee'];
};

const query = (client, text, params = []) => client.query(text, params);

const assertDemoAuthority = async (client, dataset) => {
  const authority = await query(client, `
    select 1 from organizations o join legal_entities le on le.organization_id=o.id
    where o.id=$1 and le.id=$2
  `, [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID]);
  if (authority.rowCount !== 1) throw new Error('Canonical demo organization/legal-entity authority is unavailable.');

  const ids = dataset.employees.map(item => item.id);
  const collisions = await query(client, `
    select id from employees where id=any($1::text[]) and (organization_id<>$2 or legal_entity_id<>$3)
    union all select id from clients where id=any($4::text[]) and (organization_id<>$2 or legal_entity_id<>$3)
    union all select id from projects where id=any($5::text[]) and (organization_id<>$2 or legal_entity_id<>$3)
    union all select id from project_allocations where id=any($6::text[]) and (organization_id<>$2 or legal_entity_id<>$3)
  `, [ids, DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, dataset.clients.map(item => item.id), dataset.projects.map(item => item.id), dataset.allocations.map(item => item.id)]);
  if (collisions.rowCount) throw new Error('Demo identifiers collide with records owned by another organization or legal entity.');

  const identityCollisions = await query(client, `
    select username from users
    where username=any($1::text[])
      and (employee_record_id is null or employee_record_id<>all($2::text[]))
  `, [dataset.employees.map(item => item.employeeId.toLowerCase()), ids]);
  if (identityCollisions.rowCount) throw new Error('Demo usernames collide with accounts outside the demo dataset.');
};

const seed = async () => {
  const dataset = generateDemoDataset();
  const catalogItems = [
    ...createDefaultCatalog('department', DEFAULT_DEPARTMENTS).map(item => ({ ...item, catalogType: 'departments' })),
    ...createDefaultCatalog('country', DEFAULT_COUNTRIES).map(item => ({ ...item, catalogType: 'countries' })),
    ...createDefaultCatalog('industry', DEFAULT_INDUSTRIES).map(item => ({ ...item, catalogType: 'industries' })),
  ];
  const passwordHash = await scryptHash(password);
  const client = await pool.connect();

  try {
    await client.query('begin');
    await assertDemoAuthority(client, dataset);
    await assertLegacyProjectMutationAllowed(client,{organizationId:DEMO_ORGANIZATION_ID,legalEntityId:DEMO_LEGAL_ENTITY_ID},dataset.projects.map(item=>item.id));

    const protectedWork=await query(client,`select 1 from timesheets t where t.organization_id=$1 and t.legal_entity_id=$2 and t.employee_id=any($3::text[]) and (exists(select 1 from work_submission_evidence w where w.timesheet_id=t.id) or exists(select 1 from timesheet_entries e join commercial_project_bindings b on b.project_id=e.project_id where e.timesheet_id=t.id)) limit 1`,[DEMO_ORGANIZATION_ID,DEMO_LEGAL_ENTITY_ID,dataset.employees.map(item=>item.id)]);
    if(protectedWork.rowCount)throw new Error('Demo seed cannot replace governed or retained submitted work.');

    if (reset) {
      const accepted=await query(client,"select 1 from timesheets where organization_id=$1 and legal_entity_id=$2 and employee_id=any($3::text[]) and status in ('Submitted','Approved') limit 1",[DEMO_ORGANIZATION_ID,DEMO_LEGAL_ENTITY_ID,dataset.employees.map(item=>item.id)]);
      if(accepted.rowCount)throw new Error('Demo reset cannot delete submitted or approved work history.');
      const employeeIds = dataset.employees.map(item => item.id);
      const userIds = (await query(client, 'select id from users where employee_record_id=any($1::text[])', [employeeIds])).rows.map(row => row.id);
      await query(client, 'delete from timesheet_entries where timesheet_id in (select id from timesheets where organization_id=$1 and legal_entity_id=$2 and employee_id=any($3::text[]))', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, employeeIds]);
      await query(client, 'delete from timesheets where organization_id=$1 and legal_entity_id=$2 and employee_id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, employeeIds]);
      await query(client, 'delete from project_allocations where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, dataset.allocations.map(item => item.id)]);
      await query(client, 'delete from worker_history where organization_id=$1 and legal_entity_id=$2 and employee_id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, employeeIds]);
      await query(client, 'delete from worker_profiles where organization_id=$1 and legal_entity_id=$2 and employee_id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, employeeIds]);
      if (userIds.length) await query(client, 'delete from user_organization_scopes where user_id=any($1::uuid[]) and organization_id=$2 and legal_entity_id=$3', [userIds, DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID]);
      await query(client, 'delete from users where employee_record_id=any($1::text[])', [employeeIds]);
      await query(client, 'delete from projects where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, dataset.projects.map(item => item.id)]);
      await query(client, 'delete from employees where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, employeeIds]);
      await query(client, 'delete from clients where organization_id=$1 and legal_entity_id=$2 and id=any($3::text[])', [DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, dataset.clients.map(item => item.id)]);
    }

    await query(client, `
      insert into roles(name)
      values ('Employee'), ('TeamLead'), ('ProjectManager'), ('CountryDirector'), ('HR'), ('Admin')
      on conflict (name) do nothing
    `);

    await query(client, `
      delete from catalog_items a
      using catalog_items b
      where a.catalog_type = b.catalog_type
        and lower(a.name) = lower(b.name)
        and a.id > b.id
    `);

    for (const director of dataset.countryDirectors) {
      await query(client, `
        insert into country_directors (id, name, region)
        values ($1,$2,$3)
        on conflict (id) do update set name = excluded.name, region = excluded.region
      `, [director.id, director.name, director.region]);
    }

    for (const item of catalogItems) {
      await query(client, `
        delete from catalog_items
        where id <> $1
          and lower(catalog_type) = lower($2)
          and lower(name) = lower($3)
      `, [item.id, item.catalogType, item.name]);

      await query(client, `
        insert into catalog_items (id, catalog_type, name, active, created_at, updated_at)
        values ($1,$2,$3,$4,$5,$6)
        on conflict (id) do update set
          catalog_type = excluded.catalog_type,
          name = excluded.name,
          active = excluded.active,
          updated_at = excluded.updated_at
      `, [item.id, item.catalogType, item.name, item.active, item.createdAt, item.updatedAt || item.createdAt]);
    }

    for (const role of dataset.roleDefinitions) {
      await query(client, `
        insert into role_definitions (id, name, department, description, active, created_at, updated_at)
        values ($1,$2,$3,$4,$5,$6,now())
        on conflict (id) do update set
          name = excluded.name,
          department = excluded.department,
          description = excluded.description,
          active = excluded.active,
          updated_at = now()
      `, [role.id, role.name, role.department, role.description || null, role.active, role.createdAt || new Date().toISOString()]);
    }

    for (const account of dataset.clients) {
      await query(client, `
        insert into clients (id, name, industry, account_owner_id, status, created_at, updated_at, organization_id, legal_entity_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (id) do update set
          name = excluded.name,
          industry = excluded.industry,
          account_owner_id = excluded.account_owner_id,
          status = excluded.status,
          updated_at = excluded.updated_at
      `, [account.id, account.name, account.industry, account.accountOwnerId || null, account.status, account.createdAt, account.updatedAt, DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID]);

      await query(client, 'delete from client_country_director_map where client_id = $1', [account.id]);
      for (const directorId of account.countryDirectorIds || []) {
        await query(client, `
          insert into client_country_director_map (client_id, country_director_id)
          values ($1,$2)
          on conflict do nothing
        `, [account.id, directorId]);
      }
    }

    for (const employee of dataset.employees) {
      const reportingManagerId = employee.reportingManagerId && dataset.employees.some(item => item.id === employee.reportingManagerId)
        ? employee.reportingManagerId
        : null;
      await query(client, `
        insert into employees (
          id, employee_id, name, email, designation, department, country, region, business_unit, reporting_manager_id,
          primary_country_director_id, status, utilization_eligible, expected_weekly_hours, updated_at, organization_id, legal_entity_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16)
        on conflict (id) do update set
          employee_id = excluded.employee_id,
          name = excluded.name,
          email = excluded.email,
          designation = excluded.designation,
          department = excluded.department,
          country = excluded.country,
          region = excluded.region,
          business_unit = excluded.business_unit,
          reporting_manager_id = excluded.reporting_manager_id,
          primary_country_director_id = excluded.primary_country_director_id,
          status = excluded.status,
          utilization_eligible = excluded.utilization_eligible,
          expected_weekly_hours = excluded.expected_weekly_hours,
          updated_at = now()
      `, [
        employee.id,
        employee.employeeId,
        employee.name,
        employee.email,
        employee.designation,
        employee.department,
        employee.country,
        employee.region || employee.country,
        employee.businessUnit || 'Other',
        reportingManagerId,
        employee.primaryCountryDirectorId,
        employee.status,
        employee.utilizationEligible ?? true,
        40,
        DEMO_ORGANIZATION_ID,
        DEMO_LEGAL_ENTITY_ID,
      ]);

      const lifecycleStatus = employee.status === 'Exited' ? 'Exited' : employee.status === 'On Leave' ? 'On Leave' : 'Active';
      await query(client, `insert into worker_profiles (employee_id,organization_id,legal_entity_id,lifecycle_status,effective_from)
        values ($1,$2,$3,$4,coalesce($5::date,current_date)) on conflict (employee_id) do nothing`,
      [employee.id, DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, lifecycleStatus, employee.joiningDate || employee.createdAt || null]);
      await query(client, `insert into worker_history (employee_id,organization_id,legal_entity_id,effective_from,status,snapshot)
        select $1,$2,$3,wp.effective_from,$4,to_jsonb(e) from worker_profiles wp join employees e on e.id=wp.employee_id
        where wp.employee_id=$1 and not exists (select 1 from worker_history where employee_id=$1)`,
      [employee.id, DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, lifecycleStatus]);

      await query(client, 'delete from employee_country_director_map where employee_id = $1', [employee.id]);
      for (const directorId of employee.mappedCountryDirectorIds || []) {
        await query(client, `
          insert into employee_country_director_map (employee_id, country_director_id)
          values ($1,$2)
          on conflict do nothing
        `, [employee.id, directorId]);
      }
    }

    for (const project of dataset.projects) {
      await query(client, `
        insert into projects (
          id, project_code, name, client_id, client, manager_id, manager_name,
          billable, start_date, end_date, status, updated_at, organization_id, legal_entity_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)
        on conflict (id) do update set
          project_code = excluded.project_code,
          name = excluded.name,
          client_id = excluded.client_id,
          client = excluded.client,
          manager_id = excluded.manager_id,
          manager_name = excluded.manager_name,
          billable = excluded.billable,
          start_date = excluded.start_date,
          end_date = excluded.end_date,
          status = excluded.status,
          updated_at = now()
      `, [
        project.id,
        project.projectCode,
        project.name,
        project.clientId || null,
        project.client,
        project.managerId,
        project.managerName,
        project.billable,
        project.startDate,
        project.endDate,
        project.status,
        DEMO_ORGANIZATION_ID,
        DEMO_LEGAL_ENTITY_ID,
      ]);
    }

    for (const allocation of dataset.allocations) {
      await query(client, `
        insert into project_allocations (
          id, employee_id, project_id, role_on_project, percentage,
          start_date, end_date, billable, status, organization_id, legal_entity_id, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
        on conflict (id) do update set
          employee_id = excluded.employee_id,
          project_id = excluded.project_id,
          role_on_project = excluded.role_on_project,
          percentage = excluded.percentage,
          start_date = excluded.start_date,
          end_date = excluded.end_date,
          billable = excluded.billable,
          status = excluded.status,
          updated_at = now()
      `, [
        allocation.id,
        allocation.employeeId,
        allocation.projectId,
        allocation.roleOnProject || null,
        allocation.percentage,
        allocation.startDate,
        allocation.endDate,
        allocation.billable,
        allocation.status,
        DEMO_ORGANIZATION_ID,
        DEMO_LEGAL_ENTITY_ID,
      ]);
    }

    const roleIds = new Map((await query(client, 'select id, name from roles')).rows.map(role => [role.name, role.id]));
    for (const employee of dataset.employees) {
      const username = employee.employeeId.toLowerCase();
      const result = await query(client, `
        insert into users (username, employee_id, employee_record_id, email, password_hash, status, updated_at)
        values ($1,$2,$3,$4,$5,$6,now())
        on conflict (username) do update set
          employee_id = excluded.employee_id,
          employee_record_id = excluded.employee_record_id,
          email = excluded.email,
          password_hash = excluded.password_hash,
          status = excluded.status,
          updated_at = now()
        returning id
      `, [
        username,
        employee.employeeId,
        employee.id,
        employee.email,
        passwordHash,
        employee.status === 'Exited' ? 'Disabled' : 'Active',
      ]);
      const userId = result.rows[0].id;
      await query(client, 'delete from user_organization_scopes where user_id=$1', [userId]);
      await query(client, `insert into user_organization_scopes(user_id,organization_id,legal_entity_id,active)
        values($1,$2,$3,$4) on conflict(user_id,organization_id,legal_entity_id) do update set active=excluded.active`,
      [userId, DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID, employee.status !== 'Exited']);
      await query(client, 'delete from user_roles where user_id = $1', [userId]);
      for (const roleName of rolesForEmployee(employee)) {
        await query(client, `
          insert into user_roles (user_id, role_id)
          values ($1,$2)
          on conflict do nothing
        `, [userId, roleIds.get(roleName)]);
      }
    }

    for (const timesheet of dataset.timesheets) {
      const accepted=await query(client,"select 1 from timesheets where organization_id=$1 and legal_entity_id=$2 and employee_id=$3 and week_ending=$4 and status in ('Submitted','Approved')",[DEMO_ORGANIZATION_ID,DEMO_LEGAL_ENTITY_ID,timesheet.employeeId,timesheet.weekEnding]);
      if(accepted.rowCount)continue; // Do not rewrite accepted neutral legacy IDs or evidence.
      const result = await query(client, `
        insert into timesheets (
          employee_id, week_ending, status, total_hours, billable_hours,
          rejection_reason, submitted_at, approved_at, approved_by, rejected_at, rejected_by, updated_at,
          organization_id, legal_entity_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13)
        on conflict (organization_id, employee_id, week_ending) do update set
          status = excluded.status,
          total_hours = excluded.total_hours,
          billable_hours = excluded.billable_hours,
          rejection_reason = excluded.rejection_reason,
          submitted_at = excluded.submitted_at,
          approved_at = excluded.approved_at,
          approved_by = excluded.approved_by,
          rejected_at = excluded.rejected_at,
          rejected_by = excluded.rejected_by,
          updated_at = now()
        returning id
      `, [
        timesheet.employeeId,
        timesheet.weekEnding,
        timesheet.status,
        timesheet.totalHours,
        timesheet.billableHours,
        timesheet.rejectionReason || timesheet.rejectionNote || null,
        timesheet.submittedAt || null,
        timesheet.approvedAt || null,
        timesheet.approvedBy || null,
        timesheet.rejectedAt || null,
        timesheet.rejectedBy || null,
        DEMO_ORGANIZATION_ID,
        DEMO_LEGAL_ENTITY_ID,
      ]);
      const timesheetId = result.rows[0].id;
      await query(client, 'delete from timesheet_entries where timesheet_id = $1', [timesheetId]);
      for (const entry of timesheet.entries) {
        await query(client, `
          insert into timesheet_entries (
            timesheet_id, project_id, work_type, client_name, category,
            work_date, hours, remark, billable
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [
          timesheetId,
          entry.projectId || null,
          entry.workType,
          entry.clientName || null,
          entry.category || null,
          entry.date,
          entry.hours,
          entry.remark || null,
          entry.billable,
        ]);
      }
    }

    const lifecycleInvariant = await query(client, `
      select e.id from employees e
      left join worker_profiles wp on wp.employee_id=e.id and wp.organization_id=e.organization_id and wp.legal_entity_id=e.legal_entity_id
      left join worker_history wh on wh.employee_id=e.id and wh.organization_id=e.organization_id and wh.legal_entity_id=e.legal_entity_id
      left join users u on u.employee_record_id=e.id
      left join user_organization_scopes us on us.user_id=u.id and us.organization_id=e.organization_id and us.legal_entity_id=e.legal_entity_id
      where e.id=any($1::text[]) and e.organization_id=$2 and e.legal_entity_id=$3
      group by e.id,e.status,wp.employee_id,u.id,u.status,us.active
      having wp.employee_id is null or count(wh.id)<>1 or u.id is null
        or bool_or(us.active) is distinct from (e.status<>'Exited')
        or (e.status='Exited' and u.status<>'Disabled')
    `, [dataset.employees.map(item => item.id), DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID]);
    if (lifecycleInvariant.rowCount) throw new Error('Demo worker identity, scope, or lifecycle invariant failed.');

    await query(client, `
      insert into audit_logs (user_id, user_name, user_role, module, action, entity_type, entity_id, details, organization_id, legal_entity_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, ['system', 'Seeder', 'Admin', 'Seed', reset ? 'Reset Demo Seed' : 'Demo Seed', 'DemoDataset', 'demo',
      'Seeded backend demo data for multi-user testing', DEMO_ORGANIZATION_ID, DEMO_LEGAL_ENTITY_ID]);

    await client.query('commit');
    return {
      employees: dataset.employees.length,
      clients: dataset.clients.length,
      projects: dataset.projects.length,
      allocations: dataset.allocations.length,
      timesheets: dataset.timesheets.length,
      reset,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

try {
  const summary = await seed();
  console.log(JSON.stringify({ status: 'seeded', ...summary }, null, 2));
} catch (error) {
  console.error('Demo seed failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
