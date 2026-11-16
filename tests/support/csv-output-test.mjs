import assert from 'node:assert/strict';

// Independent parser for quoted CSV assertions; no production encoder reuse.
export const parseCsv = csv => {
  if (!csv) return [];
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<csv.length;i++) {
    const char=csv[i];
    if(char==='"') {
      if(quoted&&csv[i+1]==='"'){cell+='"';i++;}
      else quoted=!quoted;
    } else if(!quoted&&(char===','||char==='\n')) {
      row.push(cell);cell='';
      if(char==='\n'){rows.push(row);row=[];}
    } else cell+=char;
  }
  assert.equal(quoted,false,'CSV must close all quoted fields');
  row.push(cell);rows.push(row);return rows;
};
