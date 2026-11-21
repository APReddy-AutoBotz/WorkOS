import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getMigrationManifest} from '../server/migration-runner.mjs';

const lastMigration='082p_wos06_retainer_credit';
const fix=fileURLToPath(new URL('../server/migrations/082q_wos08_archive_constraint_resolution.sql',import.meta.url));

function run(command,args) {
  return new Promise((done,fail)=>{
    const child=spawn(command,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});
    let tail='';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{tail=(tail+chunk).slice(-2048);});
    child.once('error',fail);
    child.once('close',(code,signal)=>{
      if (code===0) return done();
      if (command==='psql' && tail.includes('P8201')) return fail(new Error('Destination must be an empty isolated recovery database.'));
      if (command==='psql' && tail.includes('P8202')) return fail(new Error('Archive migration ledger does not match 082p.'));
      fail(new Error(`${command} failed (${signal ?? code}). Check the archive, roles, client version and destination connection.`));
    });
  });
}

async function restore(archive) {
  if (!archive || process.argv.length!==3 || !(process.env.PGSERVICE || process.env.PGDATABASE))
    throw new Error('Select an isolated destination with PGSERVICE or PGDATABASE and supply one trusted custom-format archive.');
  const manifest=await getMigrationManifest();
  const end=manifest.findIndex(m=>m.id===lastMigration);
  if (end<0) throw new Error('Historical migration manifest unavailable.');
  const ledger=manifest.slice(0,end+1).map(m=>m.id).sort().join(',');
  const directory=await mkdtemp(join(tmpdir(),'invoice-archive-recovery-'));
  try {
    const start=join(directory,'begin.sql'), verify=join(directory,'verify.sql');
    await writeFile(start,`do $$ begin
      if current_database() in ('postgres','template0','template1') or
         exists(select from pg_namespace where nspname not in ('public','information_schema') and nspname !~ '^pg_') or
         exists(select from pg_class where relnamespace='public'::regnamespace) or
         exists(select from pg_type where typnamespace='public'::regnamespace) or
         exists(select from pg_proc where pronamespace='public'::regnamespace)
      then raise exception 'An empty isolated recovery database is required' using errcode='P8201'; end if;
    end $$;`);
    await writeFile(verify,`do $$ begin
      if (select string_agg(id,',' order by id collate "C") from public.schema_migrations)
         is distinct from '${ledger}' then raise exception 'Unexpected archive migration ledger' using errcode='P8202'; end if;
    end $$;`);
    const files={};
    for (const section of ['pre-data','data','post-data']) {
      files[section]=join(directory,section+'.sql');
      await run('pg_restore',['--format=custom','--section='+section,'--file',files[section],resolve(archive)]);
    }
    const sql=[start,files['pre-data'],fix,files.data,verify,files['post-data']];
    await run('psql',['--no-psqlrc','--no-password','--quiet','--single-transaction','--set=ON_ERROR_STOP=on','--set=VERBOSITY=sqlstate',
      ...sql.flatMap(file=>['--file',file])]);
    console.log('082p archive restored. Run the release migrator and verify the destination before cutover.');
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
}

await restore(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
