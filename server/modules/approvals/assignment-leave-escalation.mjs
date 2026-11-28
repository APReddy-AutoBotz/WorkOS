export async function collectAssignmentLeaveBreaches(pool) {
  const pending = `from assignment_leave_open_stage_clocks c
    where c.due_at<statement_timestamp() and not exists (
      select from assignment_leave_deadline_breaches b
      where (c.origin='Assignment' and b.assignment_event_id=c.event_id)
         or (c.origin='Leave' and b.leave_event_id=c.event_id))`;
  const {rows: scopes}=await pool.query(`select distinct c.organization_id,c.legal_entity_id ${pending}
    order by c.organization_id,c.legal_entity_id limit 100`);
  for (const scope of scopes) {
    const c=await pool.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
        [['work-approval-scope',scope.organization_id,scope.legal_entity_id].join(':')]);
      await c.query(`insert into assignment_leave_deadline_breaches(assignment_event_id,leave_event_id)
        select case when c.origin='Assignment' then c.event_id end, case when c.origin='Leave' then c.event_id end
        ${pending} and c.organization_id=$1 and c.legal_entity_id=$2
        order by c.due_at,c.event_id limit 100 on conflict do nothing`,[scope.organization_id,scope.legal_entity_id]);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }
}
export async function dispatchAssignmentLeaveOverdue(pool) {
  const {rows}=await pool.query(`select distinct organization_id,legal_entity_id from assignment_leave_overdue_pending
    order by organization_id,legal_entity_id limit 100`);
  for (const scope of rows) {
    const c=await pool.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
        [['work-approval-scope',scope.organization_id,scope.legal_entity_id].join(':')]);
      const {rows: pending}=await c.query(`select breach_id from assignment_leave_overdue_pending
        where organization_id=$1 and legal_entity_id=$2 order by due_at,breach_id limit 100`,
        [scope.organization_id,scope.legal_entity_id]);
      for (const row of pending) {
        await c.query('savepoint overdue_delivery');
        try {
          await c.query('insert into assignment_leave_overdue_attempts(breach_id) values($1)',[row.breach_id]);
        } catch (error) {
          const failure={WGA05:'RECIPIENT_UNAVAILABLE',WGA06:'TEMPLATE_UNAVAILABLE'}[error.code];
          if (!failure) throw error;
          await c.query('rollback to savepoint overdue_delivery');
          await c.query('insert into assignment_leave_overdue_attempts(breach_id,failure) values($1,$2)',[row.breach_id,failure]);
        }
        await c.query('release savepoint overdue_delivery');
      }
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }
}
export async function stageDeliveryHistory(c,kind,id){
  if (!(await c.query("select to_regclass('assignment_leave_overdue_attempts') is not null as ready")).rows[0].ready) return [];
  return (await c.query(`select s.stage,s.due_at as "dueAt",coalesce(a.attempt,0) as attempts,
    case when a.attempt is null then 'Pending' when a.failure is null then 'Delivered' when a.failure='TEMPLATE_UNAVAILABLE' then 'TemplateUnavailable' else 'RecipientUnavailable' end as status
    from assignment_leave_overdue_sources s left join lateral (
      select attempt,failure from assignment_leave_overdue_attempts where breach_id=s.breach_id order by attempt desc limit 1
    ) a on true where s.kind=$1 and s.instance_id=$2 order by s.stage`,[kind,id])).rows;
}
