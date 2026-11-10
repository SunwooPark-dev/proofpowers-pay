import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalApp} from '../src/web.mjs';
import {DatabaseSync} from 'node:sqlite';

const origin='http://127.0.0.1:4317';
function setup(){const dir=mkdtempSync(join(tmpdir(),'pp-fix-'));const app=createLocalApp({filename:join(dir,'ledger.sqlite')});return {app,dir,close(){app.close();rmSync(dir,{recursive:true,force:true});}};}
async function browser(app){const first=await app.handle({method:'GET',url:'/api/inbox',headers:{host:'127.0.0.1:4317'}});return {first,send:(body,extra={})=>app.handle({method:'POST',url:'/api/proposals',headers:{host:'127.0.0.1:4317',origin,'content-type':'application/json','x-local-action':'1',cookie:first.headers['set-cookie'].split(';')[0],...extra},body:JSON.stringify(body)})};}

test('fix v2: expired OPEN rows reclaimed before capacity count',async()=>{
  const f=setup();
  try{
    const b=await browser(f.app);
    const db=new DatabaseSync(join(f.dir,'ledger.sqlite'));
    for(let i=0;i<5000;i++){
      db.prepare("INSERT INTO web_proposals VALUES(?,?,?,?,?,?,?,'OPEN',NULL)").run(
        'exp-'+i, 'sess', '{}', '{}', '{}', 'rev', Date.now()-1000);
    }
    db.close();
    const card=(await b.send({invoiceId:'S01'})).body;
    assert.equal(card.verdict,'APPROVAL_REQUIRED');
  }finally{f.close();}
});

test('fix v2: stuck CONSUMING rows reclaimed before capacity count',async()=>{
  const f=setup();
  try{
    const b=await browser(f.app);
    const db=new DatabaseSync(join(f.dir,'ledger.sqlite'));
    for(let i=0;i<5000;i++){
      db.prepare("INSERT INTO web_proposals VALUES(?,?,?,?,?,?,?,'CONSUMING',NULL)").run(
        'stuck-'+i, 'sess', '{}', '{}', '{}', 'rev', Date.now()-1000);
    }
    db.close();
    const card=(await b.send({invoiceId:'S01'})).body;
    assert.equal(card.verdict,'APPROVAL_REQUIRED');
  }finally{f.close();}
});

test('fix v2: live OPEN rows still hit the limit',async()=>{
  const f=setup();
  try{
    const b=await browser(f.app);
    const db=new DatabaseSync(join(f.dir,'ledger.sqlite'));
    for(let i=0;i<5000;i++){
      db.prepare("INSERT INTO web_proposals VALUES(?,?,?,?,?,?,?,'OPEN',NULL)").run(
        'live-'+i, 'sess', '{}', '{}', '{}', 'rev', Date.now()+60000);
    }
    db.close();
    const limited=await b.send({invoiceId:'S01'});
    assert.equal(limited.status,503);
    assert.equal(limited.body.error,'PROPOSAL_LIMIT');
  }finally{f.close();}
});
