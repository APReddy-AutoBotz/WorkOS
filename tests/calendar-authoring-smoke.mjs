import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {calendarHours,validCalendarDefinition as valid,validCalendarCommand,calendarCommandCanonical} from '../shared/calendar-authoring.mjs';
const d={name:'Synthetic explicit calendar 雪',timezone:'Etc/UTC',workingDays:[1,2,3,4,5],hoursPerDayExact:'8.00',holidays:[{date:'2030-01-01',label:'Synthetic holiday',type:'Public'}]},c={requestId:randomUUID(),lineageId:null,expectedLatestId:null,code:'SYN-CAL',effectiveFrom:'2030-01-01',definition:d,reason:'Synthetic explicit calendar authority'};
assert(valid(d));assert(validCalendarCommand(c));assert(valid({...d,holidays:[]}));
for(const hours of['0','-1','24.01','8.125','1e1',' 8','08',8,null])assert(!calendarHours(hours));for(const hours of['0.01','8','8.00','24'])assert(calendarHours(hours));
for(const x of[{...d,name:' x '},{...d,name:'x\n'},{...d,timezone:'Synthetic/Unknown'},{...d,workingDays:[]},{...d,workingDays:[2,1]},{...d,workingDays:[1,1]},{...d,workingDays:[7]},{...d,holidays:[...d.holidays,...d.holidays]},{...d,holidays:[{...d.holidays[0],date:'2030-02-30'}]},{...d,holidays:[{...d.holidays[0],type:'Default'}]},{...d,extra:true}])assert(!valid(x),JSON.stringify(x));
for(const x of[{...c,lineageId:randomUUID()},{...c,expectedLatestId:randomUUID()},{...c,code:'lower'},{...c,effectiveFrom:'2030-01-02'},{...c,reason:''},{...c,organizationId:'other'}])assert(!validCalendarCommand(x));
assert.equal(calendarCommandCanonical(c),calendarCommandCanonical(Object.fromEntries(Object.entries(c).reverse())));assert.notEqual(calendarCommandCanonical(c),calendarCommandCanonical({...c,definition:{...d,holidays:[]}}));
console.log('Prospective calendar strict native quantity, complete holiday bundle and exact command contract passed.');
