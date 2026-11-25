// Catch up from immutable stage history, including decisions recorded between ticks.
export function collectOverdueWorkStages(pool) {
  return pool.query(`insert into work_approval_overdue_stages(instance_id,stage,due_at)
    select s.instance_id,s.stage,s.due_at from work_approval_timed_stages s
    where s.due_at < least(now(),coalesce(s.decided_at,now()))
      and not exists(select from work_approval_overdue_stages e where e.instance_id=s.instance_id and e.stage=s.stage)
    order by s.due_at,s.instance_id,s.stage limit 100 on conflict do nothing`);
}

export function startOverdueWorkWorker(pool,server) {
  let running=false;
  async function tick() {
    if (running) return;
    running=true;
    try {await collectOverdueWorkStages(pool);}
    catch {console.error('Overdue work approval processing unavailable.');}
    finally {running=false;}
  }
  const timer=setInterval(tick,30_000);
  timer.unref();
  server.once('close',()=>clearInterval(timer));
}
