import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {Server} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLocalApp} from '../src/web.mjs';

function childRun(filename,env){
 return new Promise((resolve,reject)=>{
  const child=fork(filename,[],{env,stdio:['ignore','ignore','pipe','ipc']});let message,stderr='';
  const timer=setTimeout(()=>{child.kill();reject(Error('PACKAGING_WORKER_TIMEOUT'));},5000);
  child.on('message',value=>{message=value;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',status=>{clearTimeout(timer);resolve({status,message,stderr});});
 });
}
const launcher=new URL('../scripts/start-mock.mjs',import.meta.url);
test('packaging: frozen MOCK config strips PayPal keys and isolates the Windows-safe ledger path',async()=>{
 const {configureMock}=await import(launcher);
 const env={PAYPAL_MODE:'mock',PAYPAL_SECRET:'fixture',PAYPAL_SANDBOX_RUN:'1',paypal_lower:'fixture',PROOFPOWERS_PORT:'4429',KEEP:'yes'};
 const config=configureMock({env});
 assert.deepEqual(env,{PROOFPOWERS_PORT:'4429',KEEP:'yes'});
 assert.equal(config.mode,'mock');assert.equal(config.host,'127.0.0.1');assert.equal(config.port,4429);
 assert.equal(config.filename,fileURLToPath(new URL('../runtime/mock/web.sqlite',import.meta.url)));
 assert.deepEqual(config.env,{});assert.ok(Object.isFrozen(config.env));
 assert.throws(()=>{config.mode='sandbox';},TypeError);
 assert.equal(configureMock({env:{}}).port,4317);
});
test('packaging: sandbox and invalid ports are refused before runtime startup',async()=>{
 const {configureMock}=await import(launcher);
 for(const mode of ['sandbox','live','MOCK'])assert.throws(()=>configureMock({env:{},mode}),/MOCK_ONLY/);
 const env={PAYPAL_MODE:'sandbox',PAYPAL_SANDBOX_SECRET:'fixture'};
 assert.throws(()=>configureMock({env}),/MOCK_ONLY/);assert.deepEqual(env,{});
 for(const value of ['', '0','65536','4317junk','1.5',' 4317','-1'])assert.throws(()=>configureMock({env:{PROOFPOWERS_PORT:value}}),/INVALID_PORT/);
});
test('packaging: launcher child removes PayPal environment without changing the parent or listening',async()=>{
 const env={...process.env,PAYPAL_MODE:'mock',PAYPAL_SECRET:'fixture',PAYPAL_SANDBOX_SECRET:'fixture',PAYPAL_SANDBOX_RUN:'1',paypal_lower:'fixture'};
 const child=await childRun(new URL('./packaging-worker.mjs',import.meta.url),env);
 assert.equal(child.status,0,child.stderr);assert.deepEqual(child.message,{mode:'mock',keys:[]});
 assert.equal(env.PAYPAL_SECRET,'fixture');assert.equal(env.PAYPAL_MODE,'mock');
 const refused=await childRun(launcher,{...env,PAYPAL_MODE:'sandbox'});
 assert.equal(refused.status,1,'sandbox launcher must exit before opening a server');
});
for(const port of [4317,4429])test(`packaging: exact Host and Origin follow port ${port}, without sockets or provider calls`,async t=>{
 t.mock.method(Server.prototype,'listen',()=>{throw Error('OFFLINE_LISTEN');});
 t.mock.method(globalThis,'fetch',()=>{throw Error('OFFLINE_FETCH');});
 const dir=mkdtempSync(join(tmpdir(),'pp-packaging-')),app=createLocalApp({filename:join(dir,'db'),port});
 const host=`127.0.0.1:${port}`,origin=`http://${host}`,other=port===4317?4429:4317;
 try{
  const inbox=headers=>app.handle({method:'GET',url:'/api/inbox',headers:{host,...headers}});
  const first=await inbox({origin});assert.equal(first.status,200);assert.equal(first.body.mode,'mock');
  for(const bad of [`127.0.0.1:${other}`,`localhost:${port}`,`${host}.evil`,`${host}, ${host}`,'127.0.0.1'])assert.equal((await inbox({host:bad})).status,403);
  for(const bad of [`http://127.0.0.1:${other}`,`${origin}/`,'null',`https://${host}`])assert.equal((await inbox({origin:bad})).status,403);
  const send=(body,extra={})=>app.handle({method:'POST',url:'/api/proposals',headers:{host,origin,cookie:first.headers['set-cookie'].split(';')[0],'content-type':'application/json','x-local-action':'1',...extra},body:JSON.stringify(body)});
  assert.equal((await send({invoiceId:'S01'},{origin:`http://127.0.0.1:${other}`})).status,403);
  const card=(await send({invoiceId:'S01'})).body;assert.equal(card.verdict,'APPROVAL_REQUIRED');
  const paid=await send({proposalId:card.id,action:'approve',hash:card.hash});
  assert.equal(paid.body.verdict,'MOCK_PAID');assert.match(paid.body.batchId,/^MOCK-/);
 }finally{app.close();rmSync(dir,{recursive:true,force:true});}
});
