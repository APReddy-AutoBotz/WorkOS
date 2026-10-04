insert into notification_templates(id, event_type, channel, subject, body, active)
values
  ('notification-template-approval-requested-email', 'ApprovalRequested', 'Email', '{{title}}', '{{body}}\n\nOpen Configured product: {{actionUrl}}', true),
  ('notification-template-approval-requested-teams', 'ApprovalRequested', 'Teams', '{{title}}', '{{body}}', true),
  ('notification-template-approval-decided-email', 'ApprovalDecided', 'Email', '{{title}}', '{{body}}\n\nOpen Configured product: {{actionUrl}}', true),
  ('notification-template-approval-decided-teams', 'ApprovalDecided', 'Teams', '{{title}}', '{{body}}', true),
  ('notification-template-test-delivery-inapp', 'TestDelivery', 'InApp', '{{title}}', '{{body}}', true),
  ('notification-template-test-delivery-email', 'TestDelivery', 'Email', '{{title}}', '{{body}}\n\nOpen Configured product: {{actionUrl}}', true),
  ('notification-template-test-delivery-teams', 'TestDelivery', 'Teams', '{{title}}', '{{body}}', true),
  ('notification-template-teams-action-teams', 'TeamsAction', 'Teams', '{{title}}', '{{body}}', true),
  ('notification-template-teams-action-email', 'TeamsAction', 'Email', '{{title}}', '{{body}}\n\nOpen Configured product: {{actionUrl}}', true)
on conflict (event_type, channel) do update set
  subject = excluded.subject,
  body = excluded.body,
  active = excluded.active,
  updated_at = now();
