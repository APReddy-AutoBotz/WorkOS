import assert from 'node:assert/strict';
import { expectedMilestoneUpgradeSnapshot } from './support/milestone-upgrade-expectations.mjs';
const before = {
  invoice_draft_batches: [{ v: { id: 'synthetic-batch', currency: 'USD' } }],
  billing_eligibility_events: [{ v: { id: 'synthetic-event', amount: '7.5' } }],
  approved_unbilled_items: [{ v: { id: 'synthetic-item' } }],
  audit_logs: [{ v: { id: 'synthetic-audit' } }],
};
const expected = expectedMilestoneUpgradeSnapshot(before);
assert.deepEqual(expected, {
  invoice_draft_batches: [{ v: { id: 'synthetic-batch', currency: 'USD', source_type: 'TM_SNAPSHOT' } }],
  billing_eligibility_events: [
    { v: { id: 'synthetic-event', amount: '7.5', milestone_instance_id: null, milestone_decision_id: null, reversal_decision_id: null, reverses_event_id: null, retainer_review_id: null, retainer_period: null, service_review_id: null, service_period_review_id: null } },
  ],
  approved_unbilled_items: [{ v: { id: 'synthetic-item', source_type: 'TM_SNAPSHOT' } }],
  audit_logs: [{ v: { id: 'synthetic-audit' } }],
});
assert(
  !Object.hasOwn(before.invoice_draft_batches[0].v, 'source_type'),
  'historical input remains unchanged',
);
assert.throws(
  () =>
    expectedMilestoneUpgradeSnapshot({
      invoice_draft_batches: [{ v: { source_type: 'MILESTONE_ACCEPTANCE' } }],
    }),
  /pre-milestone/,
);
console.log('Milestone upgrade expectations preserve prior values and require exact additive fields.');
