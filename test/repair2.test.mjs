import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPipeline,hash} from '../src/pipeline.mjs';

const agent={decision:'PAY',source:'synthetic repair2 regression'};
async function local(fn){
 const dir=mkdtempSync(join(tmpdir(),'pp-repair2-')),filename=join(dir,'ledger.sqlite');
 const ctx=JSON.parse(readFileSync(new URL('../spike/s3b_data.json',import.meta.url)));
 let app;app=openPipeline(filename,{transport:r=>app.mockTransport(r)});
 const db=new DatabaseSync(filename);
 try{await fn({app,db,ctx,inv:ctx.invoices[0]});}finally{db.close();app.close();rmSync(dir,{recursive:true,force:true});}
}
function noApproval(app,db,card){
 assert.throws(()=>app.approve(card,{confirmed:true}),/INVALID_APPROVAL_CARD|EXPLICIT_APPROVAL_REQUIRED/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM approvals').get().n,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE event='MOCK_APPROVED'").get().n,0);
 assert.equal(app.ledger().length,0);assert.equal(app.deliveries(),0);
}

test('repair2: changed displayed amount cannot approve and pay original invoice',()=>local(async({app,db,ctx,inv})=>{
 const card=app.proposal(inv,ctx,agent);card.payload.amount='0.01';
 let approval,error;try{approval=app.approve(card,{confirmed:true});}catch(e){error=e;}
 if(approval){
  const result=await app.execute(inv,ctx,approval,agent);
  console.log('REPAIR2_BEFORE_REPRO',JSON.stringify({displayedAmount:card.payload.amount,originalAmount:String(inv.amount),result,deliveries:app.deliveries()}));
 }
 assert.ok(error,'mismatched displayed payload must be rejected before issuing approval');
 assert.match(error.message,/INVALID_APPROVAL_CARD/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM approvals').get().n,0);
 assert.equal(app.deliveries(),0);
}));

for(const field of ['vendor','po','invoice','payee','amount','currency','revision'])
 test(`repair2: displayed ${field} tamper rejected before approval`,()=>local(({app,db,ctx,inv})=>{
  const card=app.proposal(inv,ctx,agent);card.payload[field]=field==='revision'?2:'changed';noApproval(app,db,card);
 }));
for(const field of ['vendor','po','invoice_no','pay_to','amount','currency'])
 test(`repair2: invoice ${field} inconsistent with payload rejected`,()=>local(({app,db,ctx,inv})=>{
  const card=app.proposal(inv,ctx,agent);card.invoice[field]='changed';noApproval(app,db,card);
 }));
test('repair2: recomputed displayed hash still requires invoice consistency',()=>local(({app,db,ctx,inv})=>{
 const card=app.proposal(inv,ctx,agent);card.payload.amount='0.01';card.hash=hash(card.payload);noApproval(app,db,card);
}));
test('repair2: internally consistent future revision rejected',()=>local(({app,db,ctx,inv})=>{
 const card=app.proposal(inv,ctx,agent);card.payload.revision++;card.hash=hash(card.payload);noApproval(app,db,card);
}));
test('repair2: stale card rejected after confirmed vendor revision change',()=>local(({app,db,ctx,inv})=>{
 const card=app.proposal(inv,ctx,agent),change=app.requestVendorChange(ctx,{vendor:inv.vendor,payee:'new@merchant.example.com',requester:'A'});
 assert.equal(app.confirmVendorChange(ctx,{...change,confirmer:'B',channel:'out-of-band'}).changed,true);
 noApproval(app,db,card);
 const fresh=app.proposal({...inv,pay_to:'new@merchant.example.com'},ctx,agent);
 assert.equal(fresh.payload.revision,2);assert.ok(app.approve(fresh,{confirmed:true}).id);
}));

const malformed={
 'null card':()=>null,'missing card':()=>undefined,'array card':()=>[],
 'missing payload':c=>{delete c.payload;return c;},'null payload':c=>({...c,payload:null}),
 'array payload':c=>({...c,payload:[]}),'string payload':c=>({...c,payload:'bad'}),
 'missing invoice':c=>{delete c.invoice;return c;},'null invoice':c=>({...c,invoice:null}),
 'array invoice':c=>({...c,invoice:[]}),'string invoice':c=>({...c,invoice:'bad'}),
 'empty invoice':c=>({...c,invoice:{}}),'missing hash':c=>{delete c.hash;return c;},
 'wrong hash':c=>({...c,hash:'0'.repeat(64)}),'object hash':c=>({...c,hash:{}}),
 'missing revision':c=>{delete c.payload.revision;c.hash=hash(c.payload);return c;},
 'string revision':c=>{c.payload.revision='1';c.hash=hash(c.payload);return c;},
 'circular payload':c=>{c.payload.self=c.payload;return c;},
 'bigint payload':c=>{c.payload.amount=1n;return c;},
};
for(const [name,change] of Object.entries(malformed))test('repair2: malformed '+name+' fails closed',()=>local(({app,db,ctx,inv})=>{
 noApproval(app,db,change(app.proposal(inv,ctx,agent)));
}));
test('repair2: JSON roundtrip card retains approval, execution and replay compatibility',()=>local(async({app,ctx,inv})=>{
 const card=JSON.parse(JSON.stringify(app.proposal(inv,ctx,agent))),approval=app.approve(card,{confirmed:true});
 card.payload.amount='0.01';card.hash='changed';
 const paid=await app.execute(inv,ctx,approval,agent),replay=await app.execute(inv,ctx,approval,agent);
 assert.equal(paid.verdict,'MOCK_PAID');assert.match(paid.batchId,/^MOCK-/);
 assert.equal(replay.verdict,'REPLAY');assert.equal(replay.batchId,paid.batchId);assert.equal(app.deliveries(),1);
}));
