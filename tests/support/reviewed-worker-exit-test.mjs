import {commercialFixture as f} from './commercial-drafting-test.mjs';
export const seedExitWorker=async(pool,id,today,{sameDay=false,legal=f.legalEntityId,organization=f.organizationId}={})=>{
 await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id,joining_date)values($1,$1,'Synthetic exit worker 雪',$2,'Analyst','Delivery','US','director-commercial','Active',$3,$4,$5::date-10)`,[id,id+'@example.test',organization,legal,today]);
 await pool.query(`insert into worker_profiles(employee_id,organization_id,legal_entity_id,lifecycle_status,effective_from)values($1,$2,$3,'Active',$4::date-$5::int)`,[id,organization,legal,today,sameDay?0:10]);
 await pool.query(`insert into worker_history(employee_id,organization_id,legal_entity_id,effective_from,status,snapshot)values($1,$2,$3,$4::date-$5::int,'Active','{"source":"synthetic initial fixture"}')`,[id,organization,legal,today,sameDay?0:10]);return id;
};
export const exitSnapshot=async(pool,id)=>Object.fromEntries(await Promise.all([
 ['employees','id=$1'],['worker_profiles','employee_id=$1'],['worker_history','employee_id=$1'],['users','employee_record_id=$1'],['user_roles','user_id in(select id from users where employee_record_id=$1)'],['user_organization_scopes','user_id in(select id from users where employee_record_id=$1)'],['audit_logs',"module='Workforce Exit'and new_value->'command'->>'employeeId'=$1"]
].map(async([t,w])=>[t,(await pool.query(`select to_jsonb(t)row from ${t} t where ${w} order by to_jsonb(t)::text`,[id])).rows])));
