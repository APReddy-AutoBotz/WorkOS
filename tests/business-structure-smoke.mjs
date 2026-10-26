import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {BUSINESS_STRUCTURE_TYPES,validBusinessCommand,businessCommandCanonical} from '../shared/business-structure.mjs';
const c={requestId:randomUUID(),lineageId:null,expectedLatestId:null,type:'department',code:'SYN-雪',action:'Append',effectiveFrom:'2030-01-01',definition:{name:'Synthetic complete department 雪',parentId:null},expectedParentToken:null,reason:'Synthetic explicit source and reason'};
for(const type of BUSINESS_STRUCTURE_TYPES)assert(validBusinessCommand({...c,type}));
const withParent={...c,definition:{...c.definition,parentId:'literal-parent-雪'},expectedParentToken:'a'.repeat(64)};assert(validBusinessCommand(withParent));
const retired={...c,lineageId:randomUUID(),expectedLatestId:randomUUID(),action:'Retire'};assert(validBusinessCommand(retired));
for(const field of Object.keys(c)){const copy={...c};delete copy[field];assert(!validBusinessCommand(copy),field+' must be explicit');}
for(const x of [{...c,type:'worker_type'},{...c,organizationId:'other'},{...c,action:'Reactivate'},{...c,action:'Retire'},{...retired,expectedParentToken:'a'.repeat(64)},{...c,lineageId:randomUUID()},{...c,definition:{name:c.definition.name}},{...c,definition:{...c.definition,parentId:' parent '}},{...c,expectedParentToken:'a'.repeat(64)},{...withParent,expectedParentToken:null},{...withParent,expectedParentToken:'bad'},{...c,definition:{...c.definition,name:'unsafe\nlabel'}},{...c,reason:''},{...c,effectiveFrom:'2030-02-31'},{...c,code:' padded '},{...c,code:'x'.repeat(51)}])assert(!validBusinessCommand(x));
assert.notEqual(businessCommandCanonical(c),businessCommandCanonical(withParent));
console.log('Business-structure explicit six-family/full-parent contracts, Unicode/literal codes, strict source/retirement identities and no scope override passed.');
