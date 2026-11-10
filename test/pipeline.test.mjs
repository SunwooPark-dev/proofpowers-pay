import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openPipeline} from '../src/pipeline.mjs';
import {recordedAgent} from '../src/agent.mjs';
const original=JSON.parse(readFileSync(new URL('../spike/s3b_data.json',import.meta.url))),agent={decision:'PAY',source:'synthetic test, not AI evidence'};
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'pp-pay-test-')),db=join(dir,'ledger.sqlite');let app;const open=(options={})=>{app=openPipeline(db,{transport:options.transport??(r=>app.mockTransport(r))});return app;};return {dir,db,open,ctx:structuredClone(original),invoice:structuredClone(original.invoices[0])};};
const pay=(app,inv,ctx)=>{const card=app.proposal(inv,ctx,agent);assert.equal(card.verdict,'APPROVAL_REQUIRED');return app.execute(inv,ctx,app.approve(card,{confirmed:true}),agent);};
async function local(fn){const f=fixture();let app=f.open();try{await fn(f,app);}finally{try{app.close();}catch{}rmSync(f.dir,{recursive:true,force:true});}}
test('approved action and replay preserve one mock batch',()=>local(async(f,a)=>{const card=a.proposal(f.invoice,f.ctx,agent),approval=a.approve(card,{confirmed:true});const x=await a.execute(f.invoice,f.ctx,approval,agent),y=await a.execute(f.invoice,f.ctx,approval,agent);assert.equal(x.verdict,'MOCK_PAID');assert.equal(y.verdict,'REPLAY');assert.equal(y.batchId,x.batchId);assert.equal(a.deliveries(),1);}));
test('missing approval never invokes transport',()=>local(async(f,a)=>{assert.equal((await a.execute(f.invoice,f.ctx,null,agent)).verdict,'BLOCK');assert.equal(a.deliveries(),0);}));
test('agent HOLD cannot be overridden by synthetic approval',()=>local(async(f,a)=>{const card=a.proposal(f.invoice,f.ctx,agent),approval=a.approve(card,{confirmed:true});assert.equal((await a.execute(f.invoice,f.ctx,approval,{decision:'HOLD'})).verdict,'HOLD');assert.equal(a.deliveries(),0);}));
for(const field of ['amount','pay_to','po','invoice_no','currency'])test(`post-approval ${field} tamper blocked`,()=>local(async(f,a)=>{const card=a.proposal(f.invoice,f.ctx,agent),ap=a.approve(card,{confirmed:true}),changed={...f.invoice,[field]:field==='amount'?'43.00':field==='currency'?'EUR':'changed'};assert.deepEqual((await a.execute(changed,f.ctx,ap,agent)).reasons,['HASH_MISMATCH']);assert.equal(a.deliveries(),0);}));
test('expired approval blocked',()=>local(async(f,a)=>{const card=a.proposal(f.invoice,f.ctx,agent),ap=a.approve(card,{confirmed:true,ttlMs:1});await new Promise(r=>setTimeout(r,8));assert.equal((await a.execute(f.invoice,f.ctx,ap,agent)).verdict,'BLOCK');assert.equal(a.deliveries(),0);}));
test('approval requires explicit confirmation',()=>local(async(f,a)=>{assert.throws(()=>a.approve(a.proposal(f.invoice,f.ctx,agent)),/EXPLICIT_APPROVAL/);}));
test('B1 restart then rebilled PO remains blocked',async()=>{const f=fixture();let a=f.open();try{assert.equal((await pay(a,f.invoice,f.ctx)).verdict,'MOCK_PAID');a.close();a=f.open();const r=await pay(a,{...f.invoice,invoice_no:'REISSUED'},f.ctx);assert.deepEqual(r.reasons,['PO_ALREADY_BILLED']);assert.equal(a.deliveries(),1);}finally{a.close();rmSync(f.dir,{recursive:true,force:true});}});
test('B1 two independent processes sequentially cannot rebill same PO',async()=>{const f=fixture();try{const x=await workers(f,[f.invoice]);const y=await workers(f,[{...f.invoice,invoice_no:'OTHER-INVOICE'}]);assert.equal(x[0].verdict,'MOCK_PAID');assert.deepEqual(y[0].reasons,['PO_ALREADY_BILLED']);const a=f.open();assert.equal(a.deliveries(),1);a.close();}finally{rmSync(f.dir,{recursive:true,force:true});}});
test('B3 two processes atomically reserve one PO',async()=>{const f=fixture();try{const rows=await workers(f,[f.invoice,{...f.invoice,invoice_no:'RACE-INVOICE'}]);assert.equal(rows.filter(r=>r.verdict==='MOCK_PAID').length,1);assert.equal(rows.filter(r=>r.reasons?.some(x=>['PO_RESERVED','PO_ALREADY_BILLED'].includes(x))).length,1);const a=f.open();assert.equal(a.ledger().length,1);assert.equal(a.deliveries(),1);a.close();}finally{rmSync(f.dir,{recursive:true,force:true});}});
test('invoice uniqueness across different request hashes in two processes',async()=>{const f=fixture();delete f.ctx.purchase_orders;f.invoice.po='';try{const rows=await workers(f,[f.invoice,{...f.invoice,amount:'43.10'}]);assert.equal(rows.filter(r=>r.verdict==='MOCK_PAID').length,1);assert.equal(rows.filter(r=>r.reasons?.includes('DUPLICATE')).length,1);const a=f.open();assert.equal(a.deliveries(),1);a.close();}finally{rmSync(f.dir,{recursive:true,force:true});}});
test('ambiguous transport result survives restart without automatic retry',async()=>{const f=fixture();let hits=0,a=f.open({transport:async()=>{hits++;throw Error('ambiguous');}});try{const card=a.proposal(f.invoice,f.ctx,agent),ap=a.approve(card,{confirmed:true});const r=await a.execute(f.invoice,f.ctx,ap,agent);assert.equal(r.verdict,'HOLD');assert.equal(r.deliveryCount,null);assert.equal(a.ledger()[0].status,'UNKNOWN');a.close();a=f.open({transport:async()=>{hits++;throw Error('must not retry');}});assert.equal((await a.execute(f.invoice,f.ctx,ap,agent)).verdict,'HOLD');assert.equal(hits,1);}finally{a.close();rmSync(f.dir,{recursive:true,force:true});}});
test('guarded vendor change needs separate confirmer; invalidates old approvals',()=>local(async(f,a)=>{const card=a.proposal(f.invoice,f.ctx,agent),ap=a.approve(card,{confirmed:true});const change=a.requestVendorChange(f.ctx,{vendor:f.invoice.vendor,payee:'new@merchant.example.com',requester:'operator-A'});assert.equal(a.confirmVendorChange(f.ctx,{...change,confirmer:'operator-A',channel:'out-of-band'}).changed,false);assert.equal(a.confirmVendorChange(f.ctx,{...change,confirmer:'operator-B',channel:'out-of-band'}).changed,true);assert.equal((await a.execute(f.invoice,f.ctx,ap,agent)).verdict,'BLOCK');assert.equal(a.confirmVendorChange(f.ctx,{...change,confirmer:'operator-B',channel:'out-of-band'}).changed,false);assert.equal(a.deliveries(),0);}));
test('recorded S09 output preserved; staged errors labeled',()=>{assert.equal(recordedAgent('S09').decision,'PAY');assert.match(recordedAgent('S01',{simulateMistake:true}).source,/STAGED/);});
// USD max is interpreted only as a lifetime local-demo ledger bound.
function split(f,amounts=['140.00','140.00'],vendorIndex=1){
 const vendor=f.ctx.vendors[vendorIndex];
 return amounts.map((amount,i)=>{const po=`CAP-${vendorIndex}-${i}`;f.ctx.purchase_orders.push({po,vendor:vendor.name,amount});return {invoice_no:po,po,vendor:vendor.name,pay_to:vendor.paypal,amount,notes:'Synthetic cumulative regression.'};});
}
const capped=r=>assert.deepEqual(r.reasons,['VENDOR_CUMULATIVE_CAP']);
test('T-split: max 150 rejects second distinct valid 140 PO and invoice',()=>local(async(f,a)=>{
 const [x,y]=split(f);assert.equal(f.ctx.vendors[1].max,150);
 assert.equal((await pay(a,x,f.ctx)).verdict,'MOCK_PAID');capped(await pay(a,y,f.ctx));assert.equal(a.deliveries(),1);
}));
test('cents boundary, replay without extra exposure, independent vendors, rejection leaves headroom',()=>local(async(f,a)=>{
 const [x,y,z,extra]=split(f,['140.00','10.01','10.00','0.01']);
 const card=a.proposal(x,f.ctx,agent),ap=a.approve(card,{confirmed:true});
 assert.equal((await a.execute(x,f.ctx,ap,agent)).verdict,'MOCK_PAID');
 assert.equal((await a.execute(x,f.ctx,ap,agent)).verdict,'REPLAY');
 capped(await pay(a,y,f.ctx));assert.equal((await pay(a,z,f.ctx)).verdict,'MOCK_PAID');capped(await pay(a,extra,f.ctx));
 assert.equal((await pay(a,split(f,['200.00'],0)[0],f.ctx)).verdict,'MOCK_PAID');assert.equal(a.deliveries(),3);
}));
test('cumulative exposure persists on reopen with different PO and invoice',async()=>{
 const f=fixture();let a=f.open();try{const [x,y]=split(f);await pay(a,x,f.ctx);a.close();a=f.open();capped(await pay(a,y,f.ctx));assert.equal(a.deliveries(),1);}finally{a.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('UNKNOWN retains cumulative exposure and replay HOLD across reopen',async()=>{
 const f=fixture();let hits=0,a=f.open({transport:async()=>{hits++;throw Error('uncertain');}});
 try{const [x,y]=split(f),ap=a.approve(a.proposal(x,f.ctx,agent),{confirmed:true});assert.equal((await a.execute(x,f.ctx,ap,agent)).verdict,'HOLD');a.close();a=f.open();assert.equal((await a.execute(x,f.ctx,ap,agent)).verdict,'HOLD');capped(await pay(a,y,f.ctx));assert.equal(hits,1);assert.equal(a.deliveries(),0);}finally{a.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('two-process cumulative race uses different valid POs and invoices',async()=>{
 const f=fixture();try{const invoices=split(f),rows=await workers(f,invoices);assert.equal(rows.filter(r=>r.verdict==='MOCK_PAID').length,1);assert.equal(rows.filter(r=>r.reasons?.includes('VENDOR_CUMULATIVE_CAP')).length,1);const a=f.open();try{assert.equal(a.deliveries(),1);assert.equal(a.ledger().length,1);}finally{a.close();}}finally{rmSync(f.dir,{recursive:true,force:true});}
});
for(const status of ['SUCCEEDED','RESERVED','UNKNOWN'])test(`legacy ${status} row with unknown exposure fails closed across reopen`,async()=>{
 const f=fixture();const old=new DatabaseSync(f.db);
 old.exec("CREATE TABLE payouts(req_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,po TEXT UNIQUE,invoice_no TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('RESERVED','SUCCEEDED','UNKNOWN')),batch_id TEXT,approval_id TEXT NOT NULL UNIQUE)");
 old.prepare('INSERT INTO payouts VALUES(?,?,?,?,?,?,?)').run('old','unrecoverable','OLD-PO','OLD-INV',status,status==='SUCCEEDED'?'MOCK-OLD':null,'old-approval');old.close();
 let a=f.open();try{for(let i=0;i<2;i++){assert.deepEqual((await pay(a,f.invoice,f.ctx)).reasons,['VENDOR_EXPOSURE_UNKNOWN']);assert.equal(a.ledger()[0].status,status);assert.equal(a.deliveries(),0);a.close();a=f.open();}}finally{a.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('B3 process crash after reservation survives restart and blocks second invoice',async()=>{
 const f=fixture();const [capFirst,capSecond]=split(f);let child;
 try{
  await new Promise((resolve,reject)=>{
   child=fork(fileURLToPath(new URL('./process-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']});
   const timer=setTimeout(()=>{child.kill();reject(Error('CRASH_WORKER_TIMEOUT'));},15000);
   child.on('error',reject);child.on('message',m=>{if(m.ready)child.send({command:'go'});if(m.error)reject(Error(m.error));});
   child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('CRASH_WORKER_EXIT'));});
   child.send({command:'prepare',db:f.db,invoice:capFirst,ctx:f.ctx,crashAfterReservation:true});
  });
  const a=f.open();try{assert.equal(a.ledger()[0].status,'RESERVED');assert.deepEqual((await pay(a,{...capFirst,invoice_no:'AFTER-CRASH'},f.ctx)).reasons,['PO_RESERVED']);capped(await pay(a,capSecond,f.ctx));assert.equal(a.deliveries(),0);}finally{a.close();}
 }finally{if(child?.connected)child.disconnect();rmSync(f.dir,{recursive:true,force:true});}
});
async function workers(f,invoices){
 const handles=invoices.map(invoice=>{
  const child=fork(fileURLToPath(new URL('./process-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']});
  let onReady,onResult,failReady,failResult,finished=false;
  const ready=new Promise((resolve,reject)=>{onReady=resolve;failReady=reject;});
  const result=new Promise((resolve,reject)=>{onResult=resolve;failResult=reject;});
  const fail=error=>{failReady(error);failResult(error);};
  const timer=setTimeout(()=>fail(Error('WORKER_TIMEOUT')),15000);
  child.on('error',fail);
  child.on('exit',()=>{if(!finished)fail(Error('WORKER_EXIT'));});
  child.on('message',m=>{
   if(m.ready)onReady();
   if(m.result){finished=true;clearTimeout(timer);onResult(m.result);}
   if(m.error)fail(Error(m.error));
  });
  result.catch(()=>{});
  child.send({command:'prepare',db:f.db,invoice,ctx:f.ctx});
  return {child,ready,result,timer};
 });
 try{
  await Promise.all(handles.map(h=>h.ready));
  for(const h of handles)h.child.send({command:'go'});
  return await Promise.all(handles.map(h=>h.result));
 }finally{
  for(const h of handles){clearTimeout(h.timer);if(h.child.connected)h.child.disconnect();}
 }
}
