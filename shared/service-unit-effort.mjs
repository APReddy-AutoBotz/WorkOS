import {canonicalHours, compareHours} from './work-hours.mjs';

export const validServiceEffort = (value) =>
  typeof value === 'string' && /^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/.test(value) &&
  canonicalHours(value) !== '0' && compareHours(value,'24') <= 0;
