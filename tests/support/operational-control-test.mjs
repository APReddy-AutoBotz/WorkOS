import {commercialFixture as f} from './commercial-drafting-test.mjs';
export const seedOperationalRoster=async pool=>{
 for(let i=0;i<13;i++)await pool.query("insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)values($1,$1,'Synthetic unconfigured roster worker',$2,'Consultant','Delivery','US','director-commercial','Active',$3,$4)",['control-extra-'+String(i).padStart(2,'0'),'control-extra-'+i+'@example.test',f.organizationId,f.legalEntityId]);
 await pool.query("insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)values('control-inactive','SYN-CONTROL-INACTIVE','Synthetic inactive roster','control-inactive@example.test','Consultant','Delivery','US','director-commercial','Exited',$1,$2)",[f.organizationId,f.legalEntityId]);
};
