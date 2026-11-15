// Metadata belongs to the authenticated writer, never the submitted source row.
export const setAssignmentVersionContext=async(client,req,{employeeId,projectId,source='Web',operation='Save',reason=null,importBatchId=null,sourceIdentifier=null})=>{
 await client.query("select set_config('workos.assignment_version_context',$1,true)",[JSON.stringify({organizationId:req.organizationScope.organizationId,legalEntityId:req.organizationScope.legalEntityId,actorId:req.user.sub,activeRole:req.user.activeRole,employeeId,projectId,source,operation,reason,importBatchId,sourceIdentifier})]);
};
