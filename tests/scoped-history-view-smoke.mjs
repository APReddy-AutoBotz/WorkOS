import assert from 'node:assert/strict';
import {
  redactAuditHistoryRows,
  redactIdentityFields,
  redactIntegrationHistoryRows,
} from '../server/modules/audit/scoped-history-view.mjs';

const beforeAfter = redactAuditHistoryRows([{
  old_value: {provider_subject: 'subject-old', provider_upn: 'old@example.test', status: 'Linked'},
  new_value: {entra_object_id: 'subject-new', actionUrl: 'https://app.example.test/action/bearer-token', nested: [{upn: 'new@example.test', status: 'Linked'}]},
}])[0];
assert.deepEqual(beforeAfter, {
  old_value: {status: 'Linked'},
  new_value: {nested: [{status: 'Linked'}]},
}, 'general audit history must redact provider subjects, UPNs, Entra object IDs, and bearer action URLs recursively');

assert.deepEqual(redactIdentityFields({
  teams_user_id: 'teams-subject',
  teams_upn: 'teams@example.test',
  teams_tenant_id: 'tenant-secret',
  providerSubject: 'camel-case-subject',
  note: 'kept',
}), {note: 'kept'}, 'general history must redact snake-case and camel-case provider identity fields');

const events = redactIntegrationHistoryRows([
  {
    event_type: 'EntraLoginRejected',
    entity_id: 'raw-subject',
    request_payload: null,
    response_payload: {upn: 'login@example.test', reason: 'No active linked user'},
  },
  {
    event_type: 'IdentityLinkUpserted',
    entity_id: 'identity-link-test',
    response_payload: {provider_subject: 'raw-subject', provider_upn: 'linked@example.test', action_url: 'https://app.example.test/action/bearer-token', status: 'Linked'},
  },
]);
assert.equal(events[0].entity_id, null, 'failed unscoped SSO events must not expose an external subject in their entity ID');
assert.deepEqual(events[0].response_payload, {reason: 'No active linked user'});
assert.equal(events[1].entity_id, 'identity-link-test', 'internal identity-link IDs may remain as audit references');
assert.deepEqual(events[1].response_payload, {status: 'Linked'}, 'integration history must redact identity fields and token-bearing action URLs');

console.log('Scoped history view smoke tests passed.');
