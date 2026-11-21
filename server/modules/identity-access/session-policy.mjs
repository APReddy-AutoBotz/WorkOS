export async function assertSessionLifetime(database, lifetimeMs) {
  const {rows} = await database.query(
    'select lifetime_ms from public.deployment_session_policy where singleton',
  );
  if (Number(rows[0]?.lifetime_ms) !== lifetimeMs) {
    throw new Error('Production session lifetime must match the audited database policy.');
  }
}
