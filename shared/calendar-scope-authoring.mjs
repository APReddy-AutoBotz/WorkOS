import {approvalKeys,approvalHash}from'./work-approval.mjs';
import {calendarLabel,validCalendarCommand,calendarCommandCanonical}from'./calendar-authoring.mjs';
export {calendarCommandCanonical};
export const CALENDAR_SCOPE_AUTHORING_VERSION='calendar-scope-authoring/1';
export const CALENDAR_SCOPE_PAGE_SIZE=20;
export const validCalendarApplicability=a=>approvalKeys(a,['type','referenceId'])&&(a.type==='country'?typeof a.referenceId==='string'&&/^[A-Z]{2}$/.test(a.referenceId):a.type==='worker_group'&&calendarLabel(a.referenceId,200));
export const validCalendarScopeCommand=c=>approvalKeys(c,['requestId','lineageId','expectedLatestId','applicability','expectedAuthorityToken','code','effectiveFrom','definition','reason'])&&validCalendarApplicability(c.applicability)&&approvalHash(c.expectedAuthorityToken)&&validCalendarCommand(Object.fromEntries(Object.entries(c).filter(([k])=>!['applicability','expectedAuthorityToken'].includes(k))));
