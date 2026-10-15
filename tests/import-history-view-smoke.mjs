import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ImportHistoryDetails, ImportHistoryPanel} from '../src/components/imports/ImportHistoryPanel.tsx';
import {normalizeImportExportLog} from '../src/services/apiClient.ts';

const item = {
  id: 'synthetic-batch', operation: 'Import', channel: 'Employee CSV', fileName: 'synthetic.csv',
  status: 'Partial', totalRows: 2, validRows: 1, errorRows: 1, schemaVersion: 'project-master/1', dryRun: true,
  userName: 'Synthetic Admin', timestamp: '2026-10-15T00:00:00Z',
  errors: [{rowNumber: 2, field: 'employeeId', sourceIdentifier: '<img src=x onerror=alert(1)>', message: '<script>bad()</script>'}],
};
const html = renderToStaticMarkup(createElement(ImportHistoryDetails, {item}));
assert(html.includes('Batch reference') && html.includes('synthetic-batch'));
assert(html.includes('Schema version') && html.includes('project-master/1'));
assert(html.includes('Server-side dry run') && html.includes('Yes'));
assert(html.includes('caller-supplied diagnostics, not verified identities'));
assert(html.includes('Row 2') && html.includes('employeeId'));
assert(!html.includes('<script>') && !html.includes('<img'));
assert(html.includes('&lt;script&gt;') && html.includes('&lt;img'));
assert.match(html, /<details[ >]/);
assert.match(html, /<summary[^>]*>View details for synthetic.csv<\/summary>/);
const missing = renderToStaticMarkup(createElement(ImportHistoryDetails, {item: {...item, errors: [{rowNumber: 3, message: 'Missing'}]}}));
assert(missing.includes('Not supplied'));
const empty = renderToStaticMarkup(createElement(ImportHistoryDetails, {item: {...item, errors: undefined}}));
assert(empty.includes('No row-level diagnostics were retained'));
const large = renderToStaticMarkup(createElement(ImportHistoryDetails, {item: {...item, errors: Array.from({length: 25}, (_, i) => ({rowNumber: i + 1, message: 'Synthetic'}))}}));
assert.equal((large.match(/<li /g) || []).length, 20);
assert(large.includes('Show more row diagnostics'));
const malformed = renderToStaticMarkup(createElement(ImportHistoryDetails, {item: {...item, errors: [null, {message: {unsafe: 'object'}, sourceIdentifier: 42}]}}));
assert(malformed.includes('Diagnostic details unavailable.'));
assert(malformed.includes('Unknown'));
const normalizedVersionedBatch = normalizeImportExportLog({
  id: 'synthetic-versioned-batch', operation: 'Import', channel: 'Project Master', file_name: 'projects.csv',
  status: 'Dry Run', total_rows: 1, valid_rows: 1, error_rows: 0, schema_version: 'project-master/1', dry_run: true,
  user_name: 'Synthetic Admin', created_at: '2026-10-15T00:00:00Z',
});
assert.equal(normalizedVersionedBatch.schemaVersion, 'project-master/1');
assert.equal(normalizedVersionedBatch.dryRun, true);
const loading = renderToStaticMarkup(createElement(ImportHistoryPanel, {loadHistory: async () => []}));
assert(loading.includes('Loading operation history'));
assert(!loading.includes('No bulk data operations'));
const page = readFileSync('src/pages/ImportExport.tsx', 'utf8');
assert.match(page, /<ImportHistoryPanel loadHistory=\{adminService\.getImportExportLogs\} revision=\{historyRevision\}/);
assert(!page.includes('history.slice(0, 8)'));
console.log('Import history presentation smoke tests passed.');
