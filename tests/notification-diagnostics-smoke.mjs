import assert from 'node:assert/strict';
import {safeNotificationMetadata, notificationFailureCode} from '../server/modules/notifications/delivery-diagnostics.mjs';
import {redactAuditHistoryRows,redactIntegrationHistoryRows} from '../server/modules/audit/scoped-history-view.mjs';
const secret='placeholder-private-provider-detail';
const raw={mode:'graph',statusCode:503,deterministic:false,error:secret,sender:secret,recipient:secret,nested:{token:secret}};
assert.deepEqual(safeNotificationMetadata(raw,true),{mode:'graph',deterministic:false,statusCode:503,errorCode:notificationFailureCode});
for(const value of [null,secret,[],{mode:secret,statusCode:secret,deterministic:secret},{statusCode:600},{statusCode:99},{statusCode:200.5}])
  assert.deepEqual(safeNotificationMetadata(value),{});
for(const event_type of ['EmailNotificationFailed','TeamsNotificationFailed','InAppNotificationFailed']) {
  const output=redactIntegrationHistoryRows([{event_type,status:'Failed',request_payload:raw,response_payload:raw}])[0];
  assert.equal(JSON.stringify(output).includes(secret),false);
  assert.equal(output.response_payload.errorCode,notificationFailureCode);
  assert.equal(output.response_payload.statusCode,503);
}
const notification={module:'Notifications',action:'Send Notification',new_value:{title:'Authorized notice',deliveryResults:[{channel:'Email',provider:'graph',status:'Failed',error:secret,nested:raw}]}};
const output=redactAuditHistoryRows([notification])[0];
assert.equal(JSON.stringify(output).includes(secret),false);
assert.equal(output.new_value.title,'Authorized notice');
assert.deepEqual(output.new_value.deliveryResults,[{channel:'Email',provider:'graph',status:'Failed',errorCode:notificationFailureCode}]);
assert.equal(notification.new_value.deliveryResults[0].error,secret,'Historical stored input is not mutated');
assert.deepEqual(redactIntegrationHistoryRows([{event_type:'SyntheticOtherEvent',response_payload:{status:'Unchanged'}}])[0].response_payload,{status:'Unchanged'});
console.log('Notification diagnostic allowlist, historical integration/audit copies and compatibility checks passed.');
