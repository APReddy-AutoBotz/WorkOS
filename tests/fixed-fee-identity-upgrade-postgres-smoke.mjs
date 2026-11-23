import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runMigrations} from '../server/migrate.mjs';
import {commercialFixture as f,withCommercialDatabase,withCommercialMigrationsThrough,migrateCommercialDatabase,
  seedCommercialReferences,seedCommercialIdentities,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {createAmendmentHierarchy,grantAmendmentPermissions} from './support/commercial-amendments-test.mjs';

await withCommercialDatabase(async({pool,databaseUrl})=>{
  await withCommercialMigrationsThrough(94,rootDir=>runMigrations({pool,rootDir,logger:{log(){}}}));
  await seedCommercialReferences(pool);
  const identities=await seedCommercialIdentities(pool);
  await grantAmendmentPermissions(pool);
  const org=f.organizationId,legal=f.legalEntityId;
  const today=(await pool.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
  await pool.query(`insert into employees(id,employee_id,name,email,designation,department,country,primary_country_director_id,status,organization_id,legal_entity_id)
    values('syn-fixed-review','SYN-FIXED-REVIEW','Synthetic reviewer','review-fixed@example.test','Manager','Delivery','US','director-commercial','Active',$1,$2)`,[org,legal]);
  await pool.query('update users set employee_record_id=$1 where id=$2',[f.ownerId,identities.manager.id]);
  await pool.query("insert into role_permissions(role_name,permission_key,enabled) values('Employee','commercial.fixed_fee_eligibility.issue',true),('Employee','commercial.contracts.manage',true) on conflict(role_name,permission_key) do update set enabled=true");
  await pool.query(`insert into reporting_periods(id,organization_id,legal_entity_id,code,name,starts_on,ends_on,status,frequency)
    values('syn-fixed-period',$1,$2,'SYN-FIXED','Synthetic open period',$3,$3,'Open','Weekly')`,[org,legal,today]);
  await withCommercialApi({databaseUrl,identities},async({request})=>{
    const oldIssue=async code=>{
      const {pin,engagement}=await createAmendmentHierarchy(request,code,{contract:{value:'100',installments:[{dueOn:today,amount:'100'}]}});
      const id=randomUUID(),op=randomUUID(),c=await pool.connect();
      try {
        await c.query('begin');
        await c.query("select set_config('workos.fixed_fee_issue_operation',$1,true)",[op]);
        await c.query(`insert into billing_eligibility_events(id,organization_id,legal_entity_id,client_id,contract_id,
          engagement_id,source_type,version,eligible_on,currency,amount,billing_evidence,actor_id,active_role,operation_id)
          select $1,$2,$3,s.client_id,s.contract_id,$5,'FIXED_FEE_INSTALLMENT',1,$6,s.currency,s.amount,
            s.evidence||jsonb_build_object('approvalReason','Synthetic historical decision'),$7,'Employee',$8
          from fixed_fee_installment_source($2,$3,$4,1,$5,$6) s`,[id,org,legal,pin,engagement.id,today,identities.reader.id,op]);
        await c.query(`insert into audit_logs(user_id,user_name,user_role,active_role,module,action,entity_type,entity_id,operation_id,
          organization_id,legal_entity_id,details,reason,new_value) select $1,'Synthetic reviewer','Employee','Employee','Commercial Drafting',
          'Approve Installment','Billing Eligibility Event',$2::text,$3,$4,$5,'Historical approval','Synthetic historical decision',
          jsonb_build_object('eventId',event_id,'itemId',id) from approved_unbilled_items where event_id=$2::uuid`,[identities.reader.id,id,op,org,legal]);
        await c.query('commit');return id;
      } finally {await c.query('rollback');c.release();}
    };
    const unresolved=await oldIssue('SYN-OLD-UNLINKED');
    await pool.query("update users set employee_record_id='syn-fixed-review' where id=$1",[identities.reader.id]);
    const verified=await oldIssue('SYN-OLD-LINKED');
    const unapplied=await createAmendmentHierarchy(request,'SYN-OLD-UNISSUED',{
      contract:{value:'100',installments:[{dueOn:today,amount:'100'}]}});
    const before=(await pool.query('select to_jsonb(ev) ev from billing_eligibility_events ev order by id')).rows;
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,['095_wos06_fixed_fee_installment_identities','096_wos06_fixed_fee_invoice_approval','097_wos06_fixed_fee_invoice_export','098_wos06_fixed_fee_credit_corrections','099_wos06_fixed_fee_work_costs','100_wos06_fixed_fee_completion_forecasts','101_wos06_fixed_fee_elapsed_values','102_wos06_fixed_fee_margin_access','103_wos06_fixed_fee_progress_values','104_wos06_fixed_fee_transition_approval','105_wos06_fixed_fee_valuation_periods','106_wos06_fixed_fee_period_statements','107_wos06_fixed_fee_risk_notice_policies']);
    assert.deepEqual((await pool.query('select to_jsonb(ev) ev from billing_eligibility_events ev order by id')).rows,before);
    const proof=await pool.query('select event_id,origin,author_worker_id,reviewer_worker_id from fixed_fee_installment_identities');
    assert.deepEqual(proof.rows,[{event_id:verified,origin:'upgrade_continuity',author_worker_id:f.ownerId,reviewer_worker_id:'syn-fixed-review'}]);
    assert.equal((await pool.query('select fixed_fee_identity_current($1) ok',[unresolved])).rows[0].ok,false);
    assert.equal((await pool.query('select fixed_fee_identity_current($1) ok',[verified])).rows[0].ok,true);
    await pool.query('update users set employee_record_id=null where id=$1',[identities.manager.id]);
    await pool.query('update users set employee_record_id=$1 where id=$2',[f.ownerId,identities.manager.id]);
    const staleAuthor=await request('/fixed-fee-schedules/'+unapplied.pin+'/register',{method:'POST',identity:identities.reader,
      body:{engagementId:unapplied.engagement.id,installment:1,reason:'Inspect historical author continuity'}});
    assert.equal(staleAuthor.status,403,JSON.stringify(staleAuthor.body));
    assert.equal((await pool.query('select fixed_fee_identity_current($1) ok',[verified])).rows[0].ok,false);
    assert.equal((await pool.query('select count(*)::int n from approved_unbilled_items')).rows[0].n,2);
    await assert.rejects(pool.query("update fixed_fee_installment_identities set origin='issue'"));
    assert.deepEqual((await migrateCommercialDatabase(pool)).applied,[]);
  });
});
console.log('Fixed-fee populated upgrade retained provable identity continuity and preserved both original charges.');
