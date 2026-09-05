import { productConfig, type Terminology } from './productConfig';

export type TerminologyKey = keyof Terminology;

export const term = (key: TerminologyKey) => productConfig.terminology[key];

export const termTitle = (key: TerminologyKey) =>
  term(key).replace(/\b\w/g, character => character.toUpperCase());

export const termPlural = (key: TerminologyKey) => {
  const value = term(key);
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
};

export const termPluralTitle = (key: TerminologyKey) =>
  termPlural(key).replace(/\b\w/g, character => character.toUpperCase());

const ENTITY_TERMS: Readonly<Record<string, TerminologyKey>> = Object.freeze({
  Timesheet: 'worklog',
  Project: 'project',
  Employee: 'employee',
  Engagement: 'engagement',
});

export const displayEntityType = (canonicalType: string) => {
  const key = ENTITY_TERMS[canonicalType];
  return key ? termTitle(key) : canonicalType;
};
