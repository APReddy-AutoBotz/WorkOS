export async function sourceReminderInboxRows(c,params,workerScope,leave) {
  const {rows:[schema]}=await c.query("select to_regclass('assignment_leave_reminder_inbox') is not null as ready");
  if (!schema.ready) return [];
  const sourceFields = leave ? 'r.request_id as "requestId",r.revision,r.stage' : 'r.assignment_id as "assignmentId",r.source_token as "sourceToken"';
  return (await c.query(`select r.id,r.kind,r.event_id as "eventId",r.instance_id as "instanceId",${sourceFields},
    r.transition_sequence as "transitionSequence",r.event_key as "eventKey",r.policy_class as "policyClass",
    r.template_id as "templateId",r.operation_id as "operationId",r.locale,r.title,r.body,r.reasons,
    r.channel_decision as "channelDecision",r.id as "deliveryId",'Delivered' as "deliveryStatus",
    r.created_at as "createdAt",rd.read_at as "readAt",true as reminder
    from assignment_leave_reminder_inbox r join employees e on e.id=r.employee_id
      and e.organization_id=r.organization_id and e.legal_entity_id=r.legal_entity_id
    left join assignment_leave_reminder_reads rd on rd.recipient_id=r.id and rd.user_id=r.user_id
    where r.user_id=$1 and r.organization_id=$2 and r.legal_entity_id=$3
      and (r.kind='leave-approval')=${leave ? 'true':'false'} and ($4::uuid is null or r.id>$4)
      and ($5::uuid is null or r.id=$5) and ${workerScope} order by r.id limit 21`,params)).rows;
}
