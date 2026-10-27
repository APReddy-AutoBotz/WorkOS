import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {validWorkerExitCommand} from '../shared/reviewed-worker-exit.mjs';
const c={requestId:randomUUID(),employeeId:'synthetic-worker-雪',expectedToken:'a'.repeat(64),reason:'Synthetic reviewed exit'};assert(validWorkerExitCommand(c));
for(const k of Object.keys(c)){const v={...c};delete v[k];assert(!validWorkerExitCommand(v));}
for(const bad of [{...c,reason:''},{...c,reason:' padded '},{...c,expectedToken:'invalid'},{...c,organizationId:'foreign'},{...c,employeeId:' padded '},{...c,status:'Active'},{...c,effectiveFrom:'1970-01-01'}])assert(!validWorkerExitCommand(bad));
console.log('Reviewed worker exit explicit inspected source/reason/request contract; no caller authority or exit-date override passed.');
