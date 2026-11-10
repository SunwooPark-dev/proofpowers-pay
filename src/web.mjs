import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {openPipeline,hash,payload,PIPELINE_REVISION} from './pipeline.mjs';
import {recordedAgent} from './agent.mjs';
import {createSandboxTransport} from './paypal-sandbox.mjs';
export function parseLocalPort(value=4317){
 if(!/^[1-9][0-9]*$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)>65535)throw Error('INVALID_PORT');
 return Number(value);
}
const context=JSON.parse(readFileSync(new URL('../spike/s3b_data.json',import.meta.url),'utf8'));
const revision=createHash('sha256').update(PIPELINE_REVISION+readFileSync(new URL('./pipeline.mjs',import.meta.url),'utf8')+readFileSync(new URL('./gate.mjs',import.meta.url),'utf8')+readFileSync(new URL('./agent.mjs',import.meta.url),'utf8')+readFileSync(new URL('./paypal-sandbox.mjs',import.meta.url),'utf8')+JSON.stringify(context)).digest('hex');
const assets=new Map([['/',['text/html; charset=utf-8','index.html']],['/app.js',['text/javascript; charset=utf-8','app.js']],['/style.css',['text/css; charset=utf-8','style.css']]].map(([url,[type,file]])=>[url,{type,text:readFileSync(new URL('../public/'+file,import.meta.url),'utf8')}]));
const keys=(x,expected)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===expected.sort().join(',');
export function createLocalApp({filename,mode='mock',env={},port=4317,now=Date.now,ttlMs=60000}={}){
 const HOST=`127.0.0.1:${parseLocalPort(port)}`,ORIGIN='http://'+HOST;
 if(!['mock','sandbox'].includes(mode)||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000)throw Error('INVALID_CONFIG');
 let pipeline;
 const transport=mode==='mock'?r=>pipeline.mockTransport(r):createSandboxTransport({mode,env});
 pipeline=openPipeline(filename,{transport,transportMode:mode});
 const db=new DatabaseSync(filename);
 db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS web_proposals(id TEXT PRIMARY KEY,session TEXT NOT NULL,card TEXT NOT NULL,invoice TEXT NOT NULL,agent TEXT NOT NULL,revision TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,result TEXT);`);
 const sessions=new Map(),inflight=new Map();
 const headers={'cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin','x-frame-options':'DENY'};
 const reply=(status,body,extra={})=>({status,headers:{...headers,'content-type':'application/json; charset=utf-8',...extra},body});
 const conflict=()=>reply(409,{verdict:'HOLD',reason:'PROPOSAL_UNAVAILABLE_OR_CHANGED'});
 function session(cookie){const m=/(?:^|;\s*)pp_session=([a-f0-9]{64})(?:;|$)/.exec(cookie??'');const value=m?.[1];return value&&sessions.get(value)>now()?value:null;}
 async function handle({method,url,headers:h={},body=''}){
  // Adapter supplies lower-case header names; route tests use the same contract.
  if(h.host!==HOST||typeof url!=='string'||!url.startsWith('/')||url.includes('?')||url.includes('#'))return reply(403,{error:'REQUEST_REJECTED'});
  if(method==='GET'&&assets.has(url)){const a=assets.get(url);return reply(200,a.text,{'content-type':a.type});}
  if(method==='GET'&&url==='/api/inbox'){
   // Check browser provenance before even looking up or allocating a session.
   // Headerless CLI smoke remains allowed in this local unauthenticated demo.
   if((h.origin!==undefined&&h.origin!==ORIGIN)||(h['sec-fetch-site']!==undefined&&!['same-origin','none'].includes(h['sec-fetch-site'])))return reply(403,{error:'REQUEST_REJECTED'});
   let sid=session(h.cookie);const extra={};
   if(!sid){for(const [id,expires] of sessions)if(expires<=now())sessions.delete(id);if(sessions.size>=128)return reply(503,{error:'SESSION_LIMIT'});sid=randomBytes(32).toString('hex');sessions.set(sid,now()+30*60*1000);extra['set-cookie']=`pp_session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`;}
   return reply(200,{mode,label:'RECORDED historical agent · no live inference',limitations:'Local unauthenticated demo; clicking approval is not owner identity authentication. Lifetime per-vendor USD cap has no time reset. No production safety guarantee.',invoices:context.invoices.map(inv=>({id:inv.id,vendor:inv.vendor,amount:inv.amount,invoice:inv.invoice_no})),ledger:pipeline.ledger()},extra);
  }
  if(url!=='/api/proposals')return reply(404,{error:'NOT_FOUND'});
  if(method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'},{allow:'POST'});
  const sid=session(h.cookie);
  if(!sid||h.origin!==ORIGIN||h['x-local-action']!=='1'||(h['sec-fetch-site']!==undefined&&h['sec-fetch-site']!=='same-origin'))return reply(403,{error:'REQUEST_REJECTED'});
  if(h['content-type']!=='application/json'||h['content-encoding'])return reply(415,{error:'JSON_REQUIRED'});
  if(typeof body!=='string'||Buffer.byteLength(body)>8192)return reply(413,{error:'BODY_LIMIT'});
  let data;try{data=JSON.parse(body);}catch{return reply(400,{error:'INVALID_JSON'});}
  if(keys(data,['invoiceId'])){
   const inv=context.invoices.find(i=>i.id===data.invoiceId);if(!inv)return reply(400,{error:'UNKNOWN_INVOICE'});
   // Reclaim capacity: expire abandoned OPEN and stuck CONSUMING rows before counting.
   db.prepare("UPDATE web_proposals SET state='EXPIRED' WHERE state='OPEN' AND expires<=?").run(now());
   db.prepare("UPDATE web_proposals SET state='EXPIRED' WHERE state='CONSUMING' AND expires<=?").run(now());
   if(db.prepare("SELECT count(*) AS n FROM web_proposals WHERE state IN ('OPEN','CONSUMING')").get().n>=5000)return reply(503,{error:'PROPOSAL_LIMIT'});
   const agent=recordedAgent(inv.id),card=pipeline.proposal(inv,context,agent);
   if(card.verdict!=='APPROVAL_REQUIRED')return reply(200,{...card,agent});
   const id=randomUUID(),expires=now()+ttlMs;
   db.prepare("INSERT INTO web_proposals VALUES(?,?,?,?,?,?,?,'OPEN',NULL)").run(id,sid,JSON.stringify(card),JSON.stringify(inv),JSON.stringify(agent),revision,expires);
   return reply(200,{id,expires,...card,agent,mode});
  }
  if(!keys(data,['proposalId','action','hash'])||!['approve','reject'].includes(data.action)||typeof data.proposalId!=='string'||typeof data.hash!=='string')return reply(400,{error:'INVALID_ACTION'});
  const row=db.prepare('SELECT * FROM web_proposals WHERE id=?').get(data.proposalId);
  if(!row||row.session!==sid)return conflict();
  const card=JSON.parse(row.card),inv=JSON.parse(row.invoice),agent=JSON.parse(row.agent);
  if(row.revision!==revision||card.hash!==data.hash||card.hash!==hash(card.payload)||card.hash!==hash(payload(inv,card.payload.revision)))return conflict();
  if(row.state==='REJECTED')return data.action==='reject'?reply(200,{verdict:'REJECTED'}):conflict();
  if(row.state==='CONSUMED')return data.action==='approve'&&row.result?reply(200,JSON.parse(row.result)):conflict();
  if(row.state==='CONSUMING')return data.action==='approve'?(inflight.get(row.id)??conflict()):conflict();
  if(row.state!=='OPEN')return conflict();
  if(row.expires<=now()){db.prepare("UPDATE web_proposals SET state='EXPIRED' WHERE id=? AND state='OPEN'").run(row.id);return conflict();}
  if(data.action==='reject'){db.prepare("UPDATE web_proposals SET state='REJECTED' WHERE id=? AND state='OPEN'").run(row.id);return reply(200,{verdict:'REJECTED'});}
  // Claim before any await: a crash leaves CONSUMING, never a new transport attempt.
  const claimed=db.prepare("UPDATE web_proposals SET state='CONSUMING' WHERE id=? AND state='OPEN'").run(row.id);
  if(claimed.changes!==1)return conflict();
  // The synchronous claim can wait for a SQLite writer past the displayed deadline.
  if(row.expires<=now()){db.prepare("UPDATE web_proposals SET state='EXPIRED' WHERE id=? AND state='CONSUMING'").run(row.id);return conflict();}
  const work=(async()=>{
   let result;
   try{const approval=pipeline.approve(card,{confirmed:true,actor:'local-demo-click; unauthenticated',expiresAt:row.expires});result=await pipeline.execute(inv,context,approval,agent);}
   catch{result={verdict:'HOLD',reasons:['LOCAL_REVIEW_REQUIRED']};}
   db.prepare("UPDATE web_proposals SET state='CONSUMED',result=? WHERE id=?").run(JSON.stringify(result),row.id);
   return reply(200,result);
  })();
  inflight.set(row.id,work);try{return await work;}finally{inflight.delete(row.id);}
 }
 return {handle:async request=>{try{return await handle(request);}catch{return reply(500,{error:'LOCAL_REVIEW_REQUIRED'});}},ledger:pipeline.ledger,close(){db.close();pipeline.close();}};
}
