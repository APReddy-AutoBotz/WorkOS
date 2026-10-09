import assert from 'node:assert/strict';
import {
  redactAuditHistoryRows,
  redactIdentityFields,
  redactIntegrationHistoryRows,
} from '../server/modules/audit/scoped-history-view.mjs';

const beforeAfter = redactAuditHistoryRows([{
  old_value: {provider_subject: 'subject-old', provider_upn: 'old@example.test', status: 'Linked'},
  new_value: {
    entra_object_id: 'subject-new',
    actionUrl: 'https://app.example.test/action/bearer-token',
    body: 'Please review. Action link: https://app.example.test/teams/actions/bearer-token.',
    nested: [{upn: 'new@example.test', status: 'Linked'}],
  },
}])[0];
assert.deepEqual(beforeAfter, {
  old_value: {status: 'Linked'},
  new_value: {body: 'Please review. Action link: [redacted action URL].', nested: [{status: 'Linked'}]},
}, 'general audit history must redact identity fields and bearer action URLs recursively, including embedded text');

const identityAudit = redactAuditHistoryRows([{
  entity_id: 'identity-link-old-provider-subject',
  source_identifier: 'history-ref-old@example.test',
  old_value: {id: 'identity-link-old-provider-subject', nested: {provider_subject: 'old-provider-subject'}},
  new_value: {nested: {id: 'history-ref-old@example.test'}, provider_upn: 'old@example.test'},
}])[0];
assert.equal(identityAudit.entity_id, null, 'history must not expose a legacy row ID containing a provider subject');
assert.equal(identityAudit.source_identifier, null, 'history must not expose a legacy source ID containing a UPN');
assert.deepEqual(identityAudit.old_value, {nested: {}}, 'history must not preserve a nested ID matching a subject elsewhere in the row');
assert.deepEqual(identityAudit.new_value, {nested: {}}, 'history must not preserve a nested ID matching a UPN elsewhere in the row');

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
  {
    event_type: 'TeamsActionNotificationSent',
    entity_id: 'portal-link-test',
    response_payload: {body: 'Action link: https://app.example.test/teams/actions/bearer-token.', status: 'Sent'},
  },
  {
    event_type: 'IdentityLinkUpserted',
    entity_id: 'identity-link-raw-subject',
    response_payload: {nested: {id: 'identity-link-raw-subject'}, provider_subject: 'raw-subject', provider_upn: 'legacy@example.test', status: 'Linked'},
  },
]);
assert.equal(events[0].entity_id, null, 'failed unscoped SSO events must not expose an external subject in their entity ID');
assert.deepEqual(events[0].response_payload, {reason: 'No active linked user'});
assert.equal(events[1].entity_id, 'identity-link-test', 'internal identity-link IDs may remain as audit references');
assert.deepEqual(events[1].response_payload, {status: 'Linked'}, 'integration history must redact identity fields and token-bearing action URLs');
assert.deepEqual(events[2].response_payload, {body: 'Action link: [redacted action URL].', status: 'Sent'},
  'integration history must redact bearer action URLs embedded in notification text');
assert.equal(events[2].entity_id, 'portal-link-test');
assert.equal(events[3].entity_id, null, 'integration history must hide a legacy row ID containing a provider subject');
assert.deepEqual(events[3].response_payload, {nested: {}, status: 'Linked'},
  'integration history must also hide a nested ID whose matching subject appears elsewhere in the row');

console.log('Scoped history view smoke tests passed.');
