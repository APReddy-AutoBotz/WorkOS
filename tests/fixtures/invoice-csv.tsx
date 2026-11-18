import { BillingReconciliation } from '../../src/components/BillingReconciliation';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { InvoiceBatchApprovalWorkspace } from '../../src/components/InvoiceBatchApprovalWorkspace';
import { ReviewedInvoiceBatch } from '../../src/components/ReviewedInvoiceBatch';
import { InvoiceCsvWorkspace } from '../../src/components/InvoiceCsvWorkspace';
import { InvoiceNoticeConfiguration } from '../../src/components/InvoiceNoticeConfiguration';
import { InvoiceNoticeRecovery } from '../../src/components/InvoiceNoticeRecovery';
import { InvoiceBillingConfirmation } from '../../src/components/InvoiceBillingConfirmation';
import { CanonicalApprovalInbox } from '../../src/components/GovernedWorkApprovals';
const q = new URLSearchParams(location.search);
const choices = [{ id: q.get('engagement')!, label: 'Synthetic engagement' }];
createRoot(document.getElementById('root')!).render(
  <>
    <InvoiceBatchApprovalWorkspace choices={choices} />
    <ReviewedInvoiceBatch choices={choices} />
    <InvoiceNoticeConfiguration choices={choices} />
    <InvoiceCsvWorkspace choices={choices} />
    <InvoiceNoticeRecovery choices={choices} />
    <InvoiceBillingConfirmation choices={choices} />
    <BillingReconciliation choices={choices} />
    <CanonicalApprovalInbox />
  </>,
);
