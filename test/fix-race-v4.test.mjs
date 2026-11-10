import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

// Real behavioral tests: load the ACTUAL public/app.js in jsdom,
// replace window.fetch with a delay-controllable fake, and reproduce
// the race conditions from FIX_HANDOFF v3/v4.
// These tests FAIL on v2 app.js and PASS on v3+ app.js.

const appJs=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=`<!doctype html><html><body><header><span id="mode"></span></header><main><div id="inbox"></div><section><div id="review"></div></section><section><pre id="ledger"></pre></section><p id="status"></p></main></body></html>`;

function makeDom(fetchImpl){
  const dom=new JSDOM(html,{url:'http://127.0.0.1:4317/',runScripts:'outside-only',pretendToBeVisual:true});
  dom.window.fetch=fetchImpl;
  dom.window.eval(appJs);
  return dom;
}

// Fake API: inbox returns 4 invoices (S01 APPROVAL_REQUIRED, S09 BLOCK, S02 APPROVAL_REQUIRED, S03 HOLD).
// Proposals return a card. Approve returns MOCK_PAID after a controllable delay.
function makeFetch(delays={}){
  const pending={};
  const calls=[];
  const fetch=async(url,opts)=>{
    calls.push({url,opts});
    const body=opts?.body?JSON.parse(opts.body):null;
    if(url==='/api/inbox'){
      return {ok:true,json:async()=>({mode:'mock',ledger:[],invoices:[
        {id:'S01',vendor:'Acme',amount:'42.10',invoice:'AC-1'},
        {id:'S02',vendor:'Bright',amount:'120.00',invoice:'BC-1'},
        {id:'S09',vendor:'Bright',amount:'120.00',invoice:'BC-9'},
        {id:'S03',vendor:'Acme',amount:'15.00',invoice:'AC-3'},
      ]})};
    }
    if(body?.invoiceId){
      const id=body.invoiceId;
      const delay=delays['inspect:'+id]??0;
      if(delay)await new Promise(r=>setTimeout(r,delay));
      if(id==='S09')return {ok:true,json:async()=>({verdict:'BLOCK',agent:{decision:'BLOCK'},reasons:['INJECTION_SUSPECT']})};
      // Real HOLD-decision card, same shape as src/pipeline.mjs proposal() returns
      // when the agent decision is not PAY (verdict HOLD, reasons AGENT_NOT_PAY).
      if(id==='S03')return {ok:true,json:async()=>({verdict:'HOLD',reasons:['AGENT_NOT_PAY'],agent:{decision:'HOLD'}})};
      // Distinct payload per invoice so stale renders are detectable in text.
      const tag=id==='S01'?'MARKER-ALPHA-S01':'MARKER-BETA-S02';
      return {ok:true,json:async()=>({id:'prop-'+id,verdict:'APPROVAL_REQUIRED',mode:'mock',expires:Date.now()+60000,hash:'abc123',payload:{vendor:'Acme',amount:'42.10',marker:tag},agent:{decision:'PAY'}})};
    }
    if(body?.proposalId){
      const delay=delays['approve']??0;
      if(delay)await new Promise(r=>setTimeout(r,delay));
      return {ok:true,json:async()=>({verdict:'MOCK_PAID',batchId:'MOCK-1'})};
    }
    return {ok:false,json:async()=>({error:'NOT_FOUND'})};
  };
  fetch.calls=calls;
  return fetch;
}

async function tick(ms=10){await new Promise(r=>setTimeout(r,ms));}

// Poll until fn() is truthy (default 2s) — stale async results must not
// depend on fixed sleeps under load.
async function waitFor(fn,timeout=2000){const start=Date.now();while(Date.now()-start<timeout){if(fn())return;await tick(10);}throw new Error('waitFor timed out');}

test('v4(a): A inspect delayed, B opened, A arrives late — B screen kept',async()=>{
  const dom=makeDom(makeFetch({'inspect:S01':60,'inspect:S02':5}));
  const {document}=dom.window;
  await tick(50); // let initial inbox load
  // Click S01 (slow), then S02 (fast)
  const btns=document.querySelectorAll('#inbox button');
  btns[0].click(); // S01
  await tick(10);
  btns[1].click(); // S02
  await tick(100); // both responses arrived
  const review=document.getElementById('review').textContent;
  // B (S02) must be shown, not A (S01). S01's marker must be absent.
  assert.ok(!review.includes('MARKER-ALPHA-S01'), 'stale A inspect must not render, got: '+review.slice(0,200));
  assert.ok(review.includes('MARKER-BETA-S02'), 'B card must render');
  dom.window.close();
});

test('v4(b): A approve delayed, B(BLOCK) opened — result not attached',async()=>{
  const dom=makeDom(makeFetch({'approve':60}));
  const {document}=dom.window;
  await tick(50);
  const btns=document.querySelectorAll('#inbox button');
  btns[0].click(); // S01
  await tick(50);
  // Click approve
  const approveBtn=document.querySelector('#review button.primary');
  assert.ok(approveBtn,'approve button must exist');
  approveBtn.click();
  await tick(10);
  btns[2].click(); // S09 BLOCK
  await tick(100);
  const review=document.getElementById('review').textContent;
  assert.ok(!review.includes('MOCK_PAID'), 'stale approval must not attach under BLOCK card, got: '+review.slice(0,200));
  assert.ok(review.includes('BLOCK'), 'BLOCK card must be shown');
  // Recommended: the stale result is reported in status, and navigating
  // away clears the status text (inspect() resets it on navigation).
  await waitFor(()=>document.getElementById('status').textContent.includes('arrived after navigation'));
  btns[1].click(); // S02
  assert.equal(document.getElementById('status').textContent, '', 'status must clear on navigation');
  await tick(50);
  assert.ok(document.getElementById('review').textContent.includes('MARKER-BETA-S02'), 'S02 card must render after navigation');
  dom.window.close();
});

test('v4(c): A approve delayed, B(HOLD) opened — result not attached',async()=>{
  const fetchImpl=makeFetch({'approve':60});
  const dom=makeDom(fetchImpl);
  const {document}=dom.window;
  await tick(50);
  const btns=document.querySelectorAll('#inbox button');
  btns[0].click(); // S01
  await tick(50);
  document.querySelector('#review button.primary').click();
  await tick(10);
  btns[3].click(); // S03 — real HOLD-decision invoice card
  await tick(100);
  const review=document.getElementById('review').textContent;
  assert.ok(review.includes('HOLD'), 'HOLD card must render, got: '+review.slice(0,200));
  assert.ok(!review.includes('MOCK_PAID'), 'stale approval must not attach under HOLD card');
  // Recommended: the stale approval path must refresh the ledger
  // (app.js calls refresh() after a late result arrives).
  await waitFor(()=>fetchImpl.calls.filter(c=>c.url==='/api/inbox').length>=2);
  dom.window.close();
});

test('v4(d): A approve delayed, B opened, return to A — old result not attached',async()=>{
  const dom=makeDom(makeFetch({'approve':80}));
  const {document}=dom.window;
  await tick(50);
  const btns=document.querySelectorAll('#inbox button');
  btns[0].click(); // S01 first visit
  await tick(50);
  document.querySelector('#review button.primary').click(); // approve, slow
  await tick(10);
  btns[1].click(); // S02
  await tick(20);
  btns[0].click(); // S01 revisit — new inspect
  await tick(120); // old approval arrives
  const review=document.getElementById('review').textContent;
  assert.ok(!review.includes('MOCK_PAID'), 'old approval must not attach to revisited card, got: '+review.slice(0,300));
  dom.window.close();
});
