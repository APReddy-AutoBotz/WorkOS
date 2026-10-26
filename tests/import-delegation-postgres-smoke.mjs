import {withCommercialDatabase,migrateCommercialDatabase,withCommercialApi} from './support/commercial-drafting-test.mjs';
import {seedDelegationFixture} from './support/canonical-delegation-test.mjs';
import {configureImportedWork,proveImportedWork} from './support/import-approval-export-test.mjs';
import {createDelegatedImportHooks,finishDelegatedImport} from './support/import-delegation-test.mjs';

for(const versioned of [true,false])await withCommercialDatabase(async({pool,databaseUrl})=>{
  await migrateCommercialDatabase(pool);const fx=await seedDelegationFixture(pool);
  await withCommercialApi({databaseUrl,identities:fx.identities,onServerError:s=>process.stderr.write(s)},async({request})=>{
    await configureImportedWork(pool,request,fx);
    const hooks=await createDelegatedImportHooks({pool,request,fx});
    const proof=await proveImportedWork({pool,request,fx,versioned,hooks});
    await finishDelegatedImport({pool,request,fx,proof});
  });
});
