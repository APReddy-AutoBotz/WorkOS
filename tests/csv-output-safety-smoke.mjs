import assert from 'node:assert/strict';
import {toCsv} from '../src/lib/csv.ts';

const dangerous = [
  '=1+1', '+1+1', '-1+1', '@SUM(1)',
  '\t=1+1', '\r=1+1', '\n=1+1', '  =1+1', '\u00a0+1+1',
  '\u0000=1+1', '\u001f@SUM(1)', '\tordinary text', '\rordinary text',
  '＝1+1', '＋1+1', '－1+1', '＠SUM(1)', '  ＝1+1',
];
for (const input of dangerous) {
  const quoted = '"\'' + input.replaceAll('"', '""') + '"';
  assert.equal(toCsv([{value: input}]), '"value"\n' + quoted,
    `Unsafe value prefix must be emitted as literal text: ${JSON.stringify(input)}`);
  assert.equal(toCsv([{[input]: 'safe'}]), quoted + '\n"safe"',
    'Dynamic headers need the same protection as values');
}

assert.equal(toCsv([]), '');
assert.equal(toCsv([{name: 'Synthetic Zoë', hours: 0, note: null}, {name: '  ordinary text', hours: 7.5, extra: false}]),
  '"name","hours","note","extra"\n"Synthetic Zoë","0","",""\n"  ordinary text","7.5","","false"');
assert.equal(toCsv([{note: 'comma, quote";=1+1\nnext line'}]),
  '"note"\n"comma, quote"";=1+1\nnext line"', 'Embedded separators remain inside one quoted field');
assert.equal(toCsv([{note: '=1+1",=2+2'}]), '"note"\n"\'=1+1"",=2+2"');
assert.equal(toCsv([{note: "'=already literal"}]), '"note"\n"\'=already literal"', 'Existing literal markers are not duplicated');
assert.equal(toCsv([{quantity: -2}]), '"quantity"\n"\'-2"', 'Retain existing negative-number export behavior');
console.log('CSV hostile headers/values, control/whitespace/full-width prefixes, ordinary values and quoted field boundaries passed.');
