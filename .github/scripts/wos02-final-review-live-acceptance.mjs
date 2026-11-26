import { createRequire } from 'node:module';
import path from 'node:path';

const targetRoot = process.env.TARGET_ROOT;
const databaseUrl = process.env.DATABASE_URL;
if (!targetRoot || !databaseUrl) throw new Error('TARGET_ROOT and DATABASE_URL are required');

const requireFromTarget = createRequire(path.join(targetRoot, 'package.json'));
const pg = requireFromTarget('pg');
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query(`
    create or replace function wos02_acceptance_seed_legal_profile()
    returns trigger language plpgsql as $$
    begin
      insert into legal_entity_profile_versions(
        legal_entity_id, organization_id, legal_name, country_code, status,
        reporting_currency, address, effective_from, effective_to, authority_effective_to
      ) values (
        new.id,
        new.organization_id,
        new.name,
        case when upper(coalesce(new.country_code,'')) ~ '^[A-Z]{2}$' then upper(new.country_code) else 'US' end,
        coalesce(new.status,'Active'),
        'USD',
        jsonb_build_object('line1','Synthetic acceptance','city','Synthetic','countryCode',
          case when upper(coalesce(new.country_code,'')) ~ '^[A-Z]{2}$' then upper(new.country_code) else 'US' end),
        new.effective_from,
        new.effective_to,
        new.effective_to
      ) on conflict (legal_entity_id,effective_from) do nothing;
      return new;
    end $$;

    drop trigger if exists wos02_acceptance_seed_legal_profile on legal_entities;
    create trigger wos02_acceptance_seed_legal_profile
      after insert on legal_entities
      for each row execute function wos02_acceptance_seed_legal_profile();
  `);
} finally {
  await pool.end();
}

await import('./wos02-final-review-live-acceptance-core.mjs');
