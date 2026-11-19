import assert from 'node:assert/strict';

// Migrations 065m, 065n, 065r and 066 add these explicit columns to pre-milestone rows.
// Preserve every original value and require the precise T&M discriminator or
// null milestone references; never remove fields or derive expected values
// from the post-upgrade database.
const additions = Object.freeze({
  billing_eligibility_events: { milestone_instance_id: null, milestone_decision_id: null, reversal_decision_id: null, reverses_event_id: null },
  approved_unbilled_items: { source_type: 'TM_SNAPSHOT' },
  invoice_draft_batches: { source_type: 'TM_SNAPSHOT' },
  invoice_draft_lines: { source_type: 'TM_SNAPSHOT' },
  invoice_draft_cancellations: { source_type: 'TM_SNAPSHOT' },
  invoice_batch_confirmations: { source_type: 'TM_SNAPSHOT' },
});
export function expectedMilestoneUpgradeSnapshot(before) {
  const expected = structuredClone(before);
  for (const [table, columns] of Object.entries(additions)) {
    if (!(table in expected)) continue;
    assert(Array.isArray(expected[table]), `Expected snapshot rows for ${table}`);
    for (const row of expected[table]) {
      assert(row && row.v && typeof row.v === 'object', `Expected JSON row for ${table}`);
      for (const [column, value] of Object.entries(columns)) {
        assert(!Object.hasOwn(row.v, column), `Expected pre-milestone ${table}.${column} to be absent`);
        row.v[column] = value;
      }
    }
  }
  return expected;
}
