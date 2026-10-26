import {commercialFixture as f} from './commercial-drafting-test.mjs';
import {seedCapacity} from './worker-capacity-test.mjs';
export const seedDirectory=async pool=>{
 const fx=await seedCapacity(pool),ids=fx.identities,children=[];
 await pool.query("insert into roles(name)values('ProjectManager'),('CountryDirector'),('HR')on conflict do nothing");
 await pool.query("insert into role_permissions(role_name,permission_key,enabled)select r,'employees.view',true from unnest($1::text[])r on conflict(role_name,permission_key)do update set enabled=true",[['Admin','Employee','TeamLead','ProjectManager','CountryDirector','HR']]);
 const add=async(id,code,name,manager,entity=f.legalEntityId)=>pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id,reporting_manager_id,business_unit)values($1,$2,$3,$4,'Synthetic specialist','Synthetic delivery','US','director-commercial','Active',$5,$6,$7,'Synthetic practice')`,[id,code,name,code.toLowerCase()+'@example.test',f.organizationId,entity,manager]);
 const root='synthetic-directory-root';await add(root,'SYN-DIR-ROOT','Synthetic recorded lead',null);
 await pool.query('update employees set reporting_manager_id=$1 where id=$2',[root,f.ownerId]);
 for(let n=0;n<23;n++){const suffix=String(n).padStart(2,'0'),id='synthetic-directory-child-'+suffix;children.push(id);await add(id,'SYN-DIR-'+suffix,n===0?'Synthetic 雪 100%_ specialist':'Synthetic visible child '+suffix,f.ownerId);}
 const grandchild='synthetic-directory-grandchild';await add(grandchild,'SYN-DIR-GRAND','Synthetic recorded grandchild',children[0]);
 const unrelated='synthetic-directory-unrelated';await add(unrelated,'SYN-DIR-UNRELATED','Synthetic unrelated private worker',null);
 const other='synthetic-directory-other-legal';await add(other,'SYN-DIR-OTHER','Synthetic other legal worker',f.ownerId,f.otherLegalEntityId);
 // One named synthetic account owns this worker binding. Explicitly held test
 // roles exercise active-role scope without bypassing unique account linkage.
 for(const[name,role]of[['denied','TeamLead'],['pm','ProjectManager'],['director','CountryDirector'],['hr','HR']]){
  await pool.query('insert into user_roles(user_id,role_id)select $1,id from roles where name=$2 on conflict do nothing',[ids.reader.id,role]);ids[name]={...ids.reader,role,countryDirectorId:'director-commercial'};
 }
 await pool.query(`insert into project_allocations(id,employee_id,project_id,percentage,start_date,end_date,billable,status,organization_id,legal_entity_id)values('synthetic-directory-pm-allocation',$1,$2,10,$3,$4,true,'Active',$5,$6)`,[children[0],f.projectId,fx.monday,fx.dates[4],f.organizationId,f.legalEntityId]);
 return{...fx,root,children,grandchild,unrelated,other};
};
