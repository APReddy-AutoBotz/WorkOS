// Explicit native-currency T&M arithmetic. No binary floating point, default
// rounding, conversion, eligibility or invoice authority.
import { decimalQuantity, formatQuantity } from './work-hours.mjs';
const keys = (v, expected) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join('|') === [...expected].sort().join('|');
const quantity = (v) =>
  typeof v === 'string' &&
  /^(?:0|[1-9]\d{0,1})(?:\.\d{1,4})?$/.test(v) &&
  decimalQuantity(v).units > 0n &&
  decimalQuantity(v).units <= 24n * 10n ** BigInt(decimalQuantity(v).scale);
const amount = (v) => typeof v === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(v);
const validUncappedPolicy = (p) =>
  keys(p, [
    'version',
    'currency',
    'precision',
    'rounding',
    'aggregation',
    'capTreatment',
    'exclusions',
    'unit',
    'approvalTreatment',
  ]) &&
  p.version === 'governed-tm/1' &&
  typeof p.currency === 'string' &&
  /^[A-Z]{3}$/.test(p.currency) &&
  Number.isInteger(p.precision) &&
  p.precision >= 0 &&
  p.precision <= 4 &&
  ['HALF_UP', 'HALF_EVEN', 'DOWN'].includes(p.rounding) &&
  p.aggregation === 'PER_ENTRY' &&
  p.capTreatment === 'NONE' &&
  p.exclusions === 'NONE' &&
  p.unit === 'HOUR' &&
  p.approvalTreatment === 'NONE';
export function validTmEntryCap(value, precision) {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(value) &&
    /[1-9]/.test(value) && (value.split('.')[1]?.length ?? 0) <= precision;
}
export const validTmValuationPolicy = (policy) => {
  if (policy?.version !== 'governed-tm/2') return validUncappedPolicy(policy);
  const {capAmount, ...base} = policy;
  return base.capTreatment === 'PER_ENTRY_VALUE' && validTmEntryCap(capAmount, base.precision) &&
    validUncappedPolicy({...base, version:'governed-tm/1', capTreatment:'NONE'});
};
const exactProduct = (a, b) => {
  const x = decimalQuantity(a),
    y = decimalQuantity(b);
  return { units: x.units * y.units, scale: x.scale + y.scale };
};
const round = (value, precision, mode) => {
  const difference = value.scale - precision;
  if (difference <= 0) return value.units * 10n ** BigInt(-difference);
  const divisor = 10n ** BigInt(difference),
    base = value.units / divisor,
    remainder = value.units % divisor;
  if (mode === 'DOWN') return base;
  const twice = remainder * 2n;
  return (
    base +
    (twice > divisor ||
    (twice === divisor && (mode === 'HALF_UP' || (mode === 'HALF_EVEN' && base % 2n === 1n)))
      ? 1n
      : 0n)
  );
};
const fixed = (units, precision) => {
  const sign = units < 0n ? '-' : '',
    absolute = units < 0n ? -units : units,
    digits = absolute.toString().padStart(precision + 1, '0');
  return sign + (precision ? digits.slice(0, -precision) + '.' + digits.slice(-precision) : digits);
};
export const calculateTmEntry = ({ hours, billingRate, costRate, currency, unit, policy }) => {
  if (
    !validTmValuationPolicy(policy) ||
    !quantity(hours) ||
    !amount(billingRate) ||
    !amount(costRate) ||
    currency !== policy.currency ||
    unit !== policy.unit
  )
    throw new TypeError('Explicit compatible T&M source and rounding policy required.');
  const billing = exactProduct(hours, billingRate),
    cost = exactProduct(hours, costRate),
    ceiling = policy.version === 'governed-tm/2' ? decimalQuantity(policy.capAmount) : null,
    capped = ceiling && billing.units * 10n ** BigInt(ceiling.scale) > ceiling.units * 10n ** BigInt(billing.scale) ? ceiling : billing,
    revenueRounded = round(capped, policy.precision, policy.rounding),
    costRounded = round(cost, policy.precision, policy.rounding);
  return {
    version: policy.version,
    ...(ceiling ? {capAmount: policy.capAmount, billableAfterCapExact: formatQuantity(capped)} : {}),
    currency,
    unit,
    hoursExact: formatQuantity(decimalQuantity(hours)),
    billingRateExact: billingRate,
    costRateExact: costRate,
    unroundedBillableExact: formatQuantity(billing),
    unroundedCostExact: formatQuantity(cost),
    billableValue: fixed(revenueRounded, policy.precision),
    costValue: fixed(costRounded, policy.precision),
    marginValue: fixed(revenueRounded - costRounded, policy.precision),
  };
};
