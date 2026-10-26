// The retained ordinary modern/legacy proof executes once on import, followed
// by the delegated variants using the same real components and transports.
import {runImportedBrowser} from './import-approval-export-journey-browser-smoke.mjs';
await runImportedBrowser({delegated:true});
