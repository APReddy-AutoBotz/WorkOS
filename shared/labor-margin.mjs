import { decimalQuantity, formatQuantity } from './work-hours.mjs';

// Report percentages use two decimal places, with ties rounded away from zero.
export const calculateLaborMargin = (billable, cost) => {
  const revenue = decimalQuantity(billable);
  const expense = decimalQuantity(cost);
  const scale = Math.max(revenue.scale, expense.scale);
  const denominator = revenue.units * 10n ** BigInt(scale - revenue.scale);
  const margin = denominator - expense.units * 10n ** BigInt(scale - expense.scale);
  const sign = margin < 0n ? '-' : '';
  const magnitude = margin < 0n ? -margin : margin;
  const amount = sign + formatQuantity({units: magnitude, scale});
  if (denominator === 0n) return {amount, percent: null};
  const numerator = magnitude * 10000n;
  const rounded = numerator / denominator + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
  const digits = rounded.toString().padStart(3, '0');
  const percent = (margin < 0n && rounded !== 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2);
  return {amount, percent};
};
