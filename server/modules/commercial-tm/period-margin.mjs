import { calculateLaborMargin } from '../../../shared/labor-margin.mjs';

export const periodMarginPercent = (billable, cost) => calculateLaborMargin(billable, cost).percent;
