import {approvalKeys,approvalUuid,approvalHash} from './work-approval.mjs';
import {calendarLabel,calendarCommandCanonical} from './calendar-authoring.mjs';
import {validCapabilityDate} from './workforce-capabilities.mjs';
export const BUSINESS_STRUCTURE_VERSION='business-structure/1';
export const BUSINESS_STRUCTURE_PAGE_SIZE=20;
export const BUSINESS_STRUCTURE_TYPES=['business_unit','department','cost_centre','practice','location','region'];
export const businessType=value=>BUSINESS_STRUCTURE_TYPES.includes(value);
export const businessCode=value=>calendarLabel(value,50);
export const businessItemId=value=>calendarLabel(value,200);
export const validBusinessDefinition=value=>approvalKeys(value,['name','parentId'])&&calendarLabel(value.name,150)&&(value.parentId===null||businessItemId(value.parentId));
export const businessCommandCanonical=calendarCommandCanonical;
export const validBusinessCommand=value=>approvalKeys(value,['requestId','lineageId','expectedLatestId','type','code','action','effectiveFrom','definition','expectedParentToken','reason'])
 &&approvalUuid(value.requestId)&&(value.lineageId===null||approvalUuid(value.lineageId))&&(value.expectedLatestId===null||approvalUuid(value.expectedLatestId))
 &&Boolean(value.lineageId)===Boolean(value.expectedLatestId)&&businessType(value.type)&&businessCode(value.code)&&['Append','Retire'].includes(value.action)
 &&validCapabilityDate(value.effectiveFrom)&&validBusinessDefinition(value.definition)&&calendarLabel(value.reason,1000)
 &&(value.action==='Retire'?value.lineageId!==null&&value.expectedParentToken===null:value.definition.parentId===null?value.expectedParentToken===null:approvalHash(value.expectedParentToken));
