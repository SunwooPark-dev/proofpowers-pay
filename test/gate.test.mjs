import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gate} from '../src/gate.mjs';
for(const set of ['s3_data.json','s3b_data.json']){
 const data=JSON.parse(readFileSync(new URL('../spike/'+set,import.meta.url))),seen=new Set();
 for(const inv of data.invoices)test(`${set} ${inv.id}`,()=>{assert.equal(gate(inv,data,seen).verdict,inv.expect==='PAY'?'PASS':'BLOCK');});
}
