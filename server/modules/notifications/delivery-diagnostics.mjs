// Provider payloads are untrusted diagnostic input, never a public contract.
export const notificationFailureCode = 'NOTIFICATION_DELIVERY_FAILED';
export const safeNotificationProvider = provider =>
  ['internal', 'mock', 'graph'].includes(provider) ? provider : 'unknown';

export const safeNotificationMetadata = (value, failed = false) => {
  const safe = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (['internal', 'mock', 'graph'].includes(value.mode)) safe.mode = value.mode;
    if (typeof value.deterministic === 'boolean') safe.deterministic = value.deterministic;
    if (Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599)
      safe.statusCode = value.statusCode;
  }
  if (failed) safe.errorCode = notificationFailureCode;
  return safe;
};

export const safeNotificationDeliveryResults = value => Array.isArray(value) ? value.map(item => ({
  channel: ['InApp','Email','Teams'].includes(item?.channel) ? item.channel : 'Unknown',
  provider: safeNotificationProvider(item?.provider),
  status: ['Pending','Delivered','Failed'].includes(item?.status) ? item.status : 'Unknown',
  ...(item?.status === 'Failed' ? {errorCode:notificationFailureCode} : {}),
})) : [];

export const isNotificationDeliveryEvent = eventType =>
  /^(?:InApp|Email|Teams)Notification(?:Delivered|Failed)$/.test(eventType);
