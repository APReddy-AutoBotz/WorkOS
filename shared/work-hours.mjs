// Decimal quantities are represented as integers plus a decimal scale. No
// binary floating point rounding is used for persistence or policy decisions.
export const decimalQuantity = value => {
  const input = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(input);
  if (!match) throw new TypeError('Hours must be a non-negative decimal quantity.');
  const fraction = match[2] || '';
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || fraction.length > 1000) {
    throw new TypeError('Decimal quantity is outside the supported range.');
  }
  let units = BigInt(match[1] + fraction);
  let scale = fraction.length - exponent;
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && units % 10n === 0n) { units /= 10n; --scale; }
  return {units, scale};
};
const align = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * 10n ** BigInt(scale - a.scale), b.units * 10n ** BigInt(scale - b.scale), scale];
};
export const formatQuantity = ({units, scale}) => {
  if (units === 0n) return '0';
  const digits = units.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '') : digits;
};
export const canonicalHours = value => formatQuantity(decimalQuantity(value));
export const decimalDifference = (value, baseline) => {
  const [left, right, scale] = align(decimalQuantity(value), decimalQuantity(baseline));
  const delta = left - right;
  return (delta < 0n ? '-' : '') + formatQuantity({units: delta < 0n ? -delta : delta, scale});
};
export const compareHours = (a, b) => {
  const [left, right] = align(decimalQuantity(a), decimalQuantity(b));
  return left < right ? -1 : left > right ? 1 : 0;
};
export const isHourMultiple = (value, increment) => {
  const [quantity, step] = align(decimalQuantity(value), decimalQuantity(increment));
  return step > 0n && quantity % step === 0n;
};
export const sumHours = values => formatQuantity(values.reduce((sum, value) => {
  const [left, right, scale] = align(sum, decimalQuantity(value));
  return {units: left + right, scale};
}, {units: 0n, scale: 0}));
