import { getTerminologyValue, productConfig, type TerminologyKey } from './productConfig';

export type { TerminologyKey } from './productConfig';

export const term = (key: TerminologyKey) => productConfig.terminology[key];
export const termHelpText = (key: TerminologyKey) => getTerminologyValue(key).helpText;

export const termTitle = (key: TerminologyKey) =>
  term(key).replace(/\b\w/g, character => character.toUpperCase());

export const termPlural = (key: TerminologyKey) => getTerminologyValue(key).plural;

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
