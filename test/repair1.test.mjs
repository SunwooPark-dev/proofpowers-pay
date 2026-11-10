import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createLocalApp} from '../src/web.mjs';
import {openPipeline} from '../src/pipeline.mjs';

const host='127.0.0.1:4317',origin='http://'+host;
const inbox=(app,headers={})=>app.handle({method:'GET',url:'/api/inbox',headers:{host,...headers}});
const send=(app,cookie,body)=>app.handle({method:'POST',url:'/api/proposals',headers:{host,origin,cookie,'content-type':'application/json','x-local-action':'1'},body:JSON.stringify(body)});
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'pp-repair1-'));return {filename:join(dir,'db'),remove:()=>rmSync(dir,{recursive:true,force:true})};};

for(const hostile of [
 {origin:'http://127.0.0.1:9999'},
 {origin:'null'},
 {'sec-fetch-site':'cross-site'},
 {'sec-fetch-site':'same-site'},
 {origin,'sec-fetch-site':'cross-site'},
 {origin:'https://evil.invalid','sec-fetch-site':'same-origin'},
])test('repair1: hostile inbox headers rejected without consuming session capacity '+JSON.stringify(hostile),async()=>{
 const f=fixture(),app=createLocalApp(f);
 try{
  const responses=[];for(let i=0;i<128;i++)responses.push(await inbox(app,hostile));
  const ordinary=await inbox(app);
  assert.equal(ordinary.status,200,'hostile requests must leave room for a CLI/browser session');
  for(const r of responses){assert.equal(r.status,403);assert.equal(r.headers['set-cookie'],undefined);}
 }finally{app.close();f.remove();}
});

test('repair1: ordinary browser/CLI inbox headers, session reuse, limit and expiry remain compatible',async()=>{
 const f=fixture();let time=1000;const app=createLocalApp({...f,now:()=>time});
 try{
  for(const headers of [{},{origin},{'sec-fetch-site':'same-origin'},{'sec-fetch-site':'none'},{origin,'sec-fetch-site':'same-origin'}]){
   const r=await inbox(app,headers);assert.equal(r.status,200);assert.ok(r.headers['set-cookie']);
   const again=await inbox(app,{...headers,cookie:r.headers['set-cookie'].split(';')[0]});
   assert.equal(again.status,200);assert.equal(again.headers['set-cookie'],undefined);
  }
  for(let i=5;i<128;i++)assert.equal((await inbox(app)).status,200);
  assert.equal((await inbox(app)).status,503);
  time+=30*60*1000;assert.equal((await inbox(app)).status,200);
 }finally{app.close();f.remove();}
});

function waitFor(state,want){
 const deadline=performance.now()+5000;
 while(Atomics.load(state,0)!==want){
  const value=Atomics.load(state,0);
  if(performance.now()>=deadline)throw Error('LOCK_WORKER_TIMEOUT');
  Atomics.wait(state,0,value,100);
 }
}

for(const releaseTime of [1099,1100,1101])test(`repair1: writer delay ending at ${releaseTime} preserves displayed absolute deadline 1100`,async t=>{
 const f=fixture(),shared=new SharedArrayBuffer(12),state=new Int32Array(shared);
 Atomics.store(state,2,1000);
 t.mock.method(Date,'now',()=>Atomics.load(state,2));
 let armed=false,reads=0;
 const now=()=>{
  const value=Date.now();
  // Approval reads the session clock first, then the pre-claim expiry clock.
  if(armed&&++reads===2){Atomics.store(state,1,1);Atomics.notify(state,1);waitFor(state,2);}
  return value;
 };
 const app=createLocalApp({...f,now,ttlMs:100});let worker;
 try{
  const first=await inbox(app),cookie=first.headers['set-cookie'].split(';')[0];
  const card=(await send(app,cookie,{invoiceId:'S01'})).body;
  assert.equal(card.expires,1100);
  worker=new Worker(new URL('./repair1-lock-worker.mjs',import.meta.url),{workerData:{filename:f.filename,shared,releaseTime}});
  waitFor(state,1);armed=true;
  const result=await send(app,cookie,{proposalId:card.id,action:'approve',hash:card.hash});
  armed=false;
  assert.equal(Atomics.load(state,2),releaseTime,'real SQLite claim waited for worker release');
  if(releaseTime<1100){
   assert.equal(result.body.verdict,'MOCK_PAID');assert.match(result.body.batchId,/^MOCK-/);
   const db=new DatabaseSync(f.filename);
   try{assert.equal(db.prepare('SELECT expires FROM approvals').get().expires,1100);}finally{db.close();}
   assert.deepEqual(await send(app,cookie,{proposalId:card.id,action:'approve',hash:card.hash}),result);
  }else{
   assert.equal(result.status,409);assert.equal(app.ledger().length,0);
   const db=new DatabaseSync(f.filename);
   try{assert.equal(db.prepare('SELECT count(*) AS n FROM approvals').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM mock_deliveries').get().n,0);}finally{db.close();}
  }
 }finally{if(worker)await worker.terminate();app.close();f.remove();}
});

test('repair1: pipeline absolute expiry overrides TTL and blocks execution at original boundary',async t=>{
 const f=fixture();let time=1000;t.mock.method(Date,'now',()=>time);
 let app;app=openPipeline(f.filename,{transport:r=>app.mockTransport(r)});
 try{
  const ctx=JSON.parse(readFileSync(new URL('../spike/s3b_data.json',import.meta.url))),inv=ctx.invoices[0],agent={decision:'PAY'};
  const card=app.proposal(inv,ctx,agent),approval=app.approve(card,{confirmed:true,expiresAt:1100,ttlMs:60000});
  time=1100;
  assert.deepEqual((await app.execute(inv,ctx,approval,agent)).reasons,['APPROVAL_EXPIRED']);
  assert.equal(app.ledger().length,0);assert.equal(app.deliveries(),0);
 }finally{app.close();f.remove();}
});

test('repair1: web approval does not add clock ticks while translating the displayed deadline',async t=>{
 const f=fixture();let time=1000;
 t.mock.method(Date,'now',()=>++time);
 const app=createLocalApp({...f,now:()=>time,ttlMs:100});
 try{
  const first=await inbox(app),cookie=first.headers['set-cookie'].split(';')[0];
  const card=(await send(app,cookie,{invoiceId:'S01'})).body;assert.equal(card.expires,1100);
  const result=await send(app,cookie,{proposalId:card.id,action:'approve',hash:card.hash});
  assert.equal(result.body.verdict,'MOCK_PAID');
  const db=new DatabaseSync(f.filename);
  try{assert.equal(db.prepare('SELECT expires FROM approvals').get().expires,1100);}finally{db.close();}
 }finally{app.close();f.remove();}
});

test('repair1: pipeline rejects expired or invalid absolute approval deadlines',t=>{
 const f=fixture();t.mock.method(Date,'now',()=>1000);
 const app=openPipeline(f.filename,{transport:async()=>{throw Error('must not deliver');}});
 try{
  const ctx=JSON.parse(readFileSync(new URL('../spike/s3b_data.json',import.meta.url))),agent={decision:'PAY'};
  const card=app.proposal(ctx.invoices[0],ctx,agent);
  for(const expiresAt of [999,1000,NaN,Infinity,1100.5,'1100',null]){
   assert.throws(()=>app.approve(card,{confirmed:true,expiresAt}),/EXPLICIT_APPROVAL_REQUIRED/);
  }
  assert.equal(app.ledger().length,0);
 }finally{app.close();f.remove();}
});
