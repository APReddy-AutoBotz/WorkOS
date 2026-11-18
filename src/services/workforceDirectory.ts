import {WORKFORCE_DIRECTORY_VERSION,WORKFORCE_DIRECTORY_PAGE_SIZE,directoryId,directorySearch} from '../../shared/workforce-directory.mjs';
import {approvalKeys as keys,approvalHash as hash} from '../../shared/work-approval.mjs';
import {compareCapabilityIds} from '../../shared/workforce-capabilities.mjs';
import {api,ApiClientError,getOrganizationScope,getToken,type ApiRequestContext} from './apiClient';
import {authService} from './authService';
import {getEffectivePermissions} from './permissions';
export type DirectoryWorker={id:string;code:string;name:string;status:'Active'|'On Leave'|'Exited';designation:string;department:string;country:string;region:string|null;businessUnit:string|null;manager:{id:string;code:string;name:string}|null;visibleDirectReports:number};
export type DirectorySelection={search:string;parentId:string|null};
export type DirectoryPage={contractVersion:'workforce-directory/1';organizationId:string;legalEntityId:string;ownerKey:string;activeRole:string;selection:DirectorySelection;parent:DirectoryWorker|null;workers:DirectoryWorker[];totalMatching:number;nextAfter:string|null;rosterToken:string;observedAt:string};
export type DirectoryContext=ApiRequestContext&{identityKey:string;activeRole:string;ownerIdentity:unknown[];isCurrent:()=>boolean};
export type DirectoryPaging={after?:string;expectedRosterToken?:string};
const identity=()=>{const u=authService.getCurrentUser();return u?JSON.stringify([u.id,u.employeeId,u.userName,u.role,u.permissionRole,[...getEffectivePermissions(u)].sort()]):null;};
export const captureDirectoryContext=(isCurrent=()=>true):DirectoryContext|null=>{const u=authService.getCurrentUser(),scope=getOrganizationScope();if(!u?.userName||!scope?.organizationId||!scope.legalEntityId||!getEffectivePermissions(u).includes('employees.view'))return null;return{scope:{...scope},token:getToken(),identityKey:identity()!,activeRole:u.role,ownerIdentity:[u.userName,u.id,u.role,scope.organizationId,scope.legalEntityId],isCurrent};};
export const isDirectoryContextCurrent=(c:DirectoryContext)=>{const n=captureDirectoryContext();return Boolean(c.isCurrent()&&n&&n.identityKey===c.identityKey&&n.token===c.token&&n.scope.organizationId===c.scope.organizationId&&n.scope.legalEntityId===c.scope.legalEntityId);};
const owner=(c:DirectoryContext|null)=>{if(!c||!isDirectoryContextCurrent(c))throw new ApiClientError('Directory access changed. Reload explicitly.',{status:403});return c;};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)),text=(v:unknown):v is string=>typeof v==='string'&&v.length>0,nullable=(v:unknown)=>v===null||typeof v==='string',count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const invalid=():never=>{throw new ApiClientError('The scoped directory response could not be confirmed. Reload explicitly.',{status:503});};
const sha=async(v:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))).map(n=>n.toString(16).padStart(2,'0')).join('');
const worker=(v:unknown):v is DirectoryWorker=>object(v)&&keys(v,['id','code','name','status','designation','department','country','region','businessUnit','manager','visibleDirectReports'])&&directoryId(v.id)&&['code','name','designation','department','country'].every(k=>text(v[k]))&&['Active','On Leave','Exited'].includes(String(v.status))&&nullable(v.region)&&nullable(v.businessUnit)&&count(v.visibleDirectReports)&&(v.manager===null||object(v.manager)&&keys(v.manager,['id','code','name'])&&directoryId(v.manager.id)&&text(v.manager.code)&&text(v.manager.name));
export const decodeDirectory=(v:unknown,s:DirectorySelection,p:DirectoryPaging,c:DirectoryContext,ownerKey:string):DirectoryPage=>{
 if(!object(v)||!keys(v,['contractVersion','organizationId','legalEntityId','ownerKey','activeRole','selection','parent','workers','totalMatching','nextAfter','rosterToken','observedAt'])||v.contractVersion!==WORKFORCE_DIRECTORY_VERSION||v.organizationId!==c.scope.organizationId||v.legalEntityId!==c.scope.legalEntityId||v.ownerKey!==ownerKey||v.activeRole!==c.activeRole||!object(v.selection)||!keys(v.selection,['search','parentId'])||v.selection.search!==s.search||v.selection.parentId!==s.parentId||!hash(v.rosterToken)||p.expectedRosterToken!==undefined&&v.rosterToken!==p.expectedRosterToken||typeof v.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.observedAt)||!Number.isFinite(Date.parse(v.observedAt))||!count(v.totalMatching)||!Array.isArray(v.workers)||v.workers.length>WORKFORCE_DIRECTORY_PAGE_SIZE||v.workers.length>Number(v.totalMatching))return invalid();
 if(s.parentId===null?v.parent!==null:!worker(v.parent)||v.parent.id!==s.parentId||v.parent.visibleDirectReports<Number(v.totalMatching))return invalid();
 let previous=p.after??null;for(const row of v.workers){if(!worker(row)||previous!==null&&compareCapabilityIds(row.id,previous)<=0||s.parentId!==null&&row.manager?.id!==s.parentId)return invalid();previous=row.id;}
 if(v.nextAfter!==null&&(!directoryId(v.nextAfter)||v.workers.length!==WORKFORCE_DIRECTORY_PAGE_SIZE||v.nextAfter!==v.workers.at(-1)?.id||Number(v.totalMatching)<=v.workers.length))return invalid();
 return v as unknown as DirectoryPage;
};
export const workforceDirectoryService={read:async(s:DirectorySelection,p:DirectoryPaging,c:DirectoryContext|null)=>{
 if(!directorySearch(s.search)||!(s.parentId===null||directoryId(s.parentId))||p.after!==undefined&&!directoryId(p.after)||p.expectedRosterToken!==undefined&&!hash(p.expectedRosterToken)||p.after&&!p.expectedRosterToken)return invalid();
 const ctx=owner(c),ownerKey=await sha(ctx.ownerIdentity);owner(ctx);const raw=await api.requestWithContext<unknown>('GET','/api/v1/workforce-directory?'+new URLSearchParams({search:s.search,...s.parentId?{parentId:s.parentId}:{},...p}),undefined,ctx);owner(ctx);return decodeDirectory(raw,s,p,ctx,ownerKey);
}};
