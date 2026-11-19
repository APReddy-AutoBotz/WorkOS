import { decimalQuantity } from '../../../shared/work-hours.mjs';

// Report percentages use two decimal places, with ties rounded away from zero.
export const periodMarginPercent = (billable, cost) => {
  const revenue = decimalQuantity(billable);
  const expense = decimalQuantity(cost);
  if (revenue.units === 0n) return null;
  const scale = Math.max(revenue.scale, expense.scale);
  const denominator = revenue.units * 10n ** BigInt(scale - revenue.scale);
  const margin = denominator - expense.units * 10n ** BigInt(scale - expense.scale);
  const numerator = (margin < 0n ? -margin : margin) * 10000n;
  const rounded = numerator / denominator + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
  const digits = rounded.toString().padStart(3, '0');
  return (margin < 0n && rounded !== 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2);
};
