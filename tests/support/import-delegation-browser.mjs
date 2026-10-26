import assert from 'node:assert/strict';
import {delegationBase} from './canonical-delegation-test.mjs';

export const createDelegatedImportUi=async({fx,manager,delegate,nav,region,reply,out})=>{
  const ids=fx.identities,work='/api/v1/work-approvals';let revoked=null;
  const revoke=async adopted=>{
    if(revoked)return revoked;
    await nav(manager,'Imported work approvals');const q=region(manager,'Prospective canonical delegation');
    await q.getByRole('button',{name:'Load canonical delegation configuration',exact:true}).click();
    await q.getByLabel('Revocation reason '+adopted.id,{exact:true}).fill('Synthetic revoke future imported-work decisions');
    const pending=reply(manager,delegationBase+'/'+adopted.id+'/revoke','POST');
    await q.getByRole('button',{name:'Revoke canonical delegation '+adopted.id,exact:true}).click();
    revoked=(await out(pending,201)).delegation;
    await q.getByText(/Exact canonical delegation operation receipt confirmed/).waitFor();return revoked;
  };
  const queue=async(instance,reason,expectedSourceText)=>{
    await nav(delegate,'Imported work approvals');const q=region(delegate,'Reviewed bulk approval decisions');
    await q.getByRole('button',{name:'Clear reviewed queue',exact:true}).click();
    await q.getByLabel('Bulk source kind',{exact:true}).selectOption('Work');
    await q.getByLabel('Bulk instance reference',{exact:true}).fill(instance.id);
    let pending=reply(delegate,work+'/instances/'+instance.id);await q.getByRole('button',{name:'Inspect bulk source',exact:true}).click();await out(pending);
    const retained=q.getByRole('article',{name:'Bulk retained source review',exact:true});await retained.waitFor();
    if(expectedSourceText)await retained.getByText(expectedSourceText).waitFor();
    await q.getByLabel('Bulk item decision',{exact:true}).selectOption('Approved');
    await q.getByLabel('Bulk item reason',{exact:true}).fill(reason);
    await q.getByLabel('I inspected this retained source and current stage',{exact:true}).check();
    await q.getByRole('button',{name:'Add reviewed item',exact:true}).click();return q;
  };
  let adopted;
  return {
    adopt:async definition=>{
      await nav(manager,'Imported work approvals');const q=region(manager,'Prospective canonical delegation');
      await q.getByRole('button',{name:'Load canonical delegation configuration',exact:true}).click();
      await q.getByLabel('Existing delegate account',{exact:true}).selectOption(ids.delegate.id);
      await q.getByLabel('Delegated held role',{exact:true}).selectOption('Admin');
      await q.getByLabel('Delegation workers',{exact:true}).selectOption(definition.workerIds);
      await q.getByLabel('Delegation source kinds',{exact:true}).selectOption(definition.sourceKinds);
      await q.getByLabel('Delegation clock',{exact:true}).selectOption('UTC');
      await q.getByLabel('Delegation cohort',{exact:true}).selectOption('NewInstances');
      definition.startsAt=new Date(Date.now()+3000).toISOString();definition.endsAt=new Date(Date.now()+600000).toISOString();
      await q.getByLabel('Delegation starts UTC',{exact:true}).fill(definition.startsAt);
      await q.getByLabel('Delegation ends UTC',{exact:true}).fill(definition.endsAt);
      await q.getByLabel('Delegation adoption reason',{exact:true}).fill('Synthetic explicit imported-work prospective delegation');
      const pending=reply(manager,delegationBase,'POST');await q.getByRole('button',{name:'Record prospective canonical delegation',exact:true}).click();adopted=(await out(pending,201)).delegation;
      await q.getByText(/Exact canonical delegation operation receipt confirmed/).waitFor();return adopted;
    },
    revoke,
    decide:async(_identity,instance,reason)=>{
      const q=await queue(instance,reason,/Synthetic connected imported four approved hours/);
      const path=work+'/instances/'+instance.id+'/decisions';let writes=0,accepted;
      const intercept=async route=>{writes++;const response=await route.fetch();assert.equal(response.status(),201,await response.text());accepted=await response.json();await route.fulfill({status:200,contentType:'application/json',body:'{"unconfirmed":true}'});};
      await delegate.route('**'+path,intercept);
      try{
        await q.getByRole('button',{name:'Execute reviewed decisions',exact:true}).click();
        const item=q.getByRole('article',{name:'Bulk reviewed item '+instance.id,exact:true});await item.getByText(/· Uncertain/).waitFor();assert.equal(writes,1);
        await revoke(adopted);
        const pending=reply(delegate,work+'/instances/'+instance.id);await item.getByRole('button',{name:'Read exact request history '+instance.id,exact:true}).click();await out(pending);
        await item.getByText(/· Confirmed/).waitFor();assert.equal(writes,1,'Lost response and revocation reconcile through one read, never another write');
        assert.equal(accepted.receipt.actorId,ids.delegate.id);return accepted;
      }finally{await delegate.unroute('**'+path,intercept);}
    },
    refused:async instance=>{
      const q=await queue(instance,'Synthetic inspected stale delegated import after revocation'),pending=reply(delegate,work+'/instances/'+instance.id+'/decisions','POST');
      await q.getByRole('button',{name:'Execute reviewed decisions',exact:true}).click();await out(pending,403);
      await q.getByRole('article',{name:'Bulk reviewed item '+instance.id,exact:true}).getByText(/· Denied · HTTP 403/).waitFor();
    }
  };
};
