import {readFileSync} from 'node:fs';
const source='spike/s3b_agy_guarded_1.out';
const rows=readFileSync(new URL('../'+source,import.meta.url),'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x));
export function recordedAgent(id,{simulateMistake=false}={}){
 const row=rows.find(r=>r.id===id);
 if(!row)throw Error('NO_RECORDED_AGENT_OUTPUT');
 return {...row,decision:simulateMistake?'PAY':row.decision,source:simulateMistake?'STAGED: forced PAY, not a real model failure':source,mode:'recorded; no live inference'};
}
