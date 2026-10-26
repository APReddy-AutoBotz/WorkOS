import assert from 'node:assert/strict';
import {directoryId,directorySearch,directoryLiteral,WORKFORCE_DIRECTORY_PAGE_SIZE} from '../shared/workforce-directory.mjs';
assert.equal(WORKFORCE_DIRECTORY_PAGE_SIZE,20);assert(directoryId('synthetic-雪🚀'));assert(directorySearch('雪 100%_'));
for(const v of['','x'.repeat(201),'x\n'])assert.equal(directoryId(v),false);
for(const v of[' x','x ','x\n','x'.repeat(101),null])assert.equal(directorySearch(v),false);
assert(directorySearch(''));assert.equal(directoryLiteral('100%_\\'),'%100\\%\\_\\\\%');
console.log('Directory bounded identifiers, explicit literal search and page contract passed.');
