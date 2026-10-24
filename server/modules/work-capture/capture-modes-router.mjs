import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {lockWorkPolicy} from './assignment-work-policy.mjs';
import {CAPTURE_MODES_VERSION,captureModeInput,captureModeView,loadCaptureMode} from './capture-modes.mjs';

export const createCaptureModesRouter=({pool,requireDatabase,requireAuth,requirePermission,audit,
  logError=error=>console.error('Capture modes request failed',error?.code||'UNKNOWN')})=>{
  const router=Router();router.use(requireDatabase,requireAuth);
  router.get('/',requirePermission('timesheets.submit'),async(req,res)=>{
    try{
      const row=await loadCaptureMode(pool,req);
      const today=(await pool.query("select (now() at time zone 'UTC')::date::text today")).rows[0].today;
      res.json({organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,serverDate:today,latestId:row?.id||null,enabledModes:row?.enabled_modes||[]});
    }catch(error){logError(error);res.status(503).json({error:'Capture modes are unavailable.',code:'WORK_CAPTURE_MODES_UNAVAILABLE'});}
  });
  router.get('/settings',requirePermission('settings.manage'),async(req,res)=>{
    try{
      const {organizationId,legalEntityId}=req.organizationScope;
      const rows=(await pool.query('select * from work_capture_mode_versions where organization_id=$1 and legal_entity_id=$2 order by sequence desc limit 51',[organizationId,legalEntityId])).rows;
      res.json({organizationId,legalEntityId,latestId:rows[0]?.id||null,versions:rows.slice(0,50).map(captureModeView),truncated:rows.length>50});
    }catch(error){logError(error);res.status(503).json({error:'Capture modes are unavailable.',code:'WORK_CAPTURE_MODES_UNAVAILABLE'});}
  });
  router.post('/settings',requirePermission('settings.manage'),async(req,res)=>{
    const parsed=captureModeInput.safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:'Select one or both distinct capture modes.',code:'WORK_CAPTURE_MODES_INVALID'});return;}
    let client,open=false;
    try{
      client=await pool.connect();await client.query('begin');open=true;await lockWorkPolicy(client,req);
      const latest=await loadCaptureMode(client,req);
      if((latest?.id||null)!==parsed.data.expectedLatestId){await client.query('rollback');open=false;
        res.status(409).json({error:'Capture modes changed. Reload before appending another version.',code:'WORK_CAPTURE_MODES_CONFLICT'});return;}
      const {organizationId,legalEntityId}=req.organizationScope;
      const row=(await client.query(`insert into work_capture_mode_versions(id,organization_id,legal_entity_id,sequence,policy_version,enabled_modes,actor_id,active_role,source,correlation_id,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,'Web',$9,$10) returning *`,
      [`capture-modes-${randomUUID()}`,organizationId,legalEntityId,Number(latest?.sequence||0)+1,CAPTURE_MODES_VERSION,
        parsed.data.enabledModes,req.user.sub,req.user.activeRole,req.correlationId,req.operationId])).rows[0];
      const result=captureModeView(row);
      await audit(client,req,{module:'Work Capture',action:'Append Capture Modes',entityType:'Work Capture Modes',entityId:row.id,
        oldValue:latest?captureModeView(latest):null,newValue:result,details:'Explicit scoped daily/weekly presentation enablement; retained weekly work and approval identity unchanged.'});
      await client.query('commit');open=false;res.status(201).json(result);
    }catch(error){
      if(open)await client.query('rollback').catch(()=>{});
      if(['WCM01','23505'].includes(error?.code))res.status(409).json({error:'Capture modes changed. Reload before saving.',code:'WORK_CAPTURE_MODES_CONFLICT'});
      else{logError(error);res.status(503).json({error:'Save could not be confirmed. Reload before trying again.',code:'WORK_CAPTURE_MODES_UNAVAILABLE'});}
    }finally{client?.release();}
  });
  return router;
};
