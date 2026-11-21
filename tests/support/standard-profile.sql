-- Synthetic workload owned by one legal entity in a disposable database.
insert into employees (id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
select 'profile-worker-'||n,'PROFILE-'||n,'Synthetic worker '||n,'profile-'||n||'@example.test','Consultant','Delivery','US','director-commercial','Active','org-default','legal-default'
from generate_series(1,250) n;

update employees set reporting_manager_id='profile-worker-'||(n+70)
from generate_series(6,20) n where id='profile-worker-'||n;

insert into users (username,email,employee_id,employee_record_id)
select employee_id,email,employee_id,id from employees where id like 'profile-worker-%';
insert into roles(name) values ('Admin'),('Employee'),('TeamLead') on conflict(name) do nothing;
insert into user_roles (user_id,role_id)
select u.id,r.id from users u join roles r on r.name=case when u.username ~ '^PROFILE-[1-5]$' then 'Admin'
  when u.username ~ '^PROFILE-(7[6-9]|8[0-9]|90)$' then 'TeamLead' else 'Employee' end
where u.username like 'PROFILE-%';
insert into user_organization_scopes (user_id,organization_id,legal_entity_id,active)
select id,'org-default','legal-default',true from users where username like 'PROFILE-%';
insert into role_permissions(role_name,permission_key,enabled)
values ('Employee','timesheets.submit',true),('Admin','reports.view_utilization',true),('TeamLead','timesheets.approve',true),('TeamLead','timesheets.submit',true)
on conflict(role_name,permission_key) do update set enabled=excluded.enabled;

insert into clients(id,name,account_owner_id,organization_id,legal_entity_id)
select 'profile-client-'||n,'Synthetic client '||n,'profile-worker-1','org-default','legal-default' from generate_series(1,25) n;
insert into projects(id,project_code,name,client_id,client,manager_id,manager_name,start_date,end_date,status,organization_id,legal_entity_id)
select 'profile-project-'||n,'PROFILE-P-'||n,'Synthetic project '||n,'profile-client-'||c,'Synthetic client '||c,'profile-worker-1','Synthetic worker 1','2024-01-01','2024-12-31','Active','org-default','legal-default'
from generate_series(1,50) n cross join lateral (select 1+(n-1)%25 as c) client;
insert into project_allocations(employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)
select 'profile-worker-'||n,'profile-project-'||(1+(n-1)%50),100,'2024-01-01','2024-12-31',true,'Active','org-default','legal-default' from generate_series(1,250) n;

insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
select 'profile-week-'||w,'org-default','legal-default','PROFILE-W-'||w,'Synthetic reporting week '||w,
  date '2024-02-26'+7*w,date '2024-03-03'+7*w,'Open','Weekly' from generate_series(0,5) w;

insert into timesheets(employee_id,week_ending,status,total_hours,billable_hours,organization_id,legal_entity_id)
select 'profile-worker-'||n,date '2024-01-07'+7*w,'Approved',40,40,'org-default','legal-default' from generate_series(1,250) n cross join generate_series(0,7) w;
insert into timesheet_entries(timesheet_id,project_id,work_type,work_date,hours,billable,remark)
select t.id,a.project_id,'Project Work',t.week_ending-d,8,true,'Synthetic delivery' from timesheets t
join project_allocations a on a.employee_id=t.employee_id cross join generate_series(2,6) d
where t.employee_id like 'profile-worker-%';
insert into audit_logs(user_id,user_name,user_role,active_role,module,action,entity_type,entity_id,details,organization_id,legal_entity_id)
select u.id::text,u.username,'Employee','Employee','Timesheets','Submit','Timesheet',t.id::text,'Synthetic submission',t.organization_id,t.legal_entity_id
from timesheets t join users u on u.employee_record_id=t.employee_id where u.username like 'PROFILE-%';
