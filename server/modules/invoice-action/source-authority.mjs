import {assertCommercialAuthority} from '../commercial-drafting/service.mjs';

export const assertInvoiceActionSource = async (client, request, batch) => {
  if (batch.source_type === 'MILESTONE_ACCEPTANCE') {
    await assertCommercialAuthority(client, request, 'commercial.milestone_billing.view');
  } else if (batch.source_type !== 'TM_SNAPSHOT') {
    throw Object.assign(new Error('Invoice source authority is unavailable.'), {
      statusCode: 503, code: 'INVOICE_ACTION_SOURCE_UNAVAILABLE',
    });
  }
};

export const assertInvoiceActionEngagement = async (client, request, engagementId) => {
  const result = await client.query(`select model from commercial_engagements
    where id=$1 and organization_id=$2 and legal_entity_id=$3`,
  [engagementId, request.organizationScope.organizationId, request.organizationScope.legalEntityId]);
  if (!result.rows[0]) throw Object.assign(new Error('Scoped engagement unavailable.'), {
    statusCode: 404, code: 'INVOICE_ACTION_SOURCE',
  });
  if (result.rows[0].model === 'milestone') {
    await assertCommercialAuthority(client, request, 'commercial.milestone_billing.view');
  }
};
