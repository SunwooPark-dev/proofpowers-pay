import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {gate,normNo} from './gate.mjs';

export const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
export const payload=(inv,revision)=>({vendor:String(inv.vendor),po:normNo(inv.po),invoice:normNo(inv.invoice_no??inv.id),payee:String(inv.pay_to),amount:String(inv.amount),currency:String(inv.currency??'USD'),revision});

// Decimal conversion avoids floating-point dollar arithmetic; invalid limits fail closed.
const cents=value=>{
 const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
 if(!match)return null;
 const n=BigInt(match[1])*100n+BigInt((match[2]??'').padEnd(2,'0'));
 return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
};

export const PIPELINE_REVISION='step2-v1';
export function openPipeline(filename,{transport,transportMode='mock'}={}){
 if(!['mock','sandbox'].includes(transportMode))throw Error('INVALID_TRANSPORT_MODE');
 if(typeof transport!=='function')throw Error('EXPLICIT_MOCK_TRANSPORT_REQUIRED');
 const db=new DatabaseSync(filename);
 db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS payouts(req_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
 po TEXT UNIQUE,invoice_no TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('RESERVED','SUCCEEDED','UNKNOWN')),
 batch_id TEXT,approval_id TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS payout_exposure(
 req_id TEXT PRIMARY KEY REFERENCES payouts(req_id),vendor TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0));
 CREATE INDEX IF NOT EXISTS exposure_vendor ON payout_exposure(vendor);
 CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS vendor_master(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS vendor_changes(id TEXT PRIMARY KEY,vendor TEXT NOT NULL,payee TEXT NOT NULL,revision INTEGER NOT NULL,nonce TEXT NOT NULL,requester TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,event TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mock_deliveries(req_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL);`);
 const audit=(event,detail)=>db.prepare('INSERT INTO audit(event,detail) VALUES(?,?)').run(event,JSON.stringify(detail));
 const block=(...reasons)=>({verdict:'BLOCK',reasons,deliveryCount:0});
 function master(ctx){
  db.prepare('INSERT OR IGNORE INTO vendor_master(id,revision,data) VALUES(1,1,?)').run(JSON.stringify(ctx.vendors));
  const row=db.prepare('SELECT * FROM vendor_master WHERE id=1').get();
  return {revision:row.revision,vendors:JSON.parse(row.data)};
 }
 function proposal(inv,ctx,agent){
  const m=master(ctx),frozen=copy(inv),decision=gate(frozen,{...ctx,vendors:m.vendors},new Set());
  if(agent?.decision!=='PAY')return {verdict:'HOLD',reasons:['AGENT_NOT_PAY'],deliveryCount:0};
  if((inv.currency??'USD')!=='USD')return block('CURRENCY_UNSUPPORTED');
  if(decision.verdict!=='PASS')return block(...decision.reasons);
  return {verdict:'APPROVAL_REQUIRED',invoice:frozen,payload:payload(frozen,m.revision),hash:hash(payload(frozen,m.revision)),agentSource:agent.source};
 }
 function approve(card,{confirmed=false,actor='synthetic-demo-owner',ttlMs=60000,expiresAt}={}){
  const time=Date.now(),expires=expiresAt===undefined?time+ttlMs:expiresAt;
  if(card?.verdict!=='APPROVAL_REQUIRED'||confirmed!==true||!actor||!Number.isSafeInteger(ttlMs)||ttlMs<=0||!Number.isSafeInteger(expires)||expires<=time)throw Error('EXPLICIT_APPROVAL_REQUIRED');
  // Validate a data snapshot before writing approval; bind display and invoice to the current master revision.
  try{
   card=copy(card);
   const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
   const revision=db.prepare('SELECT revision FROM vendor_master WHERE id=1').get()?.revision;
   if(!object(card)||!object(card.payload)||!object(card.invoice)||!Number.isSafeInteger(revision)||
    card.payload.revision!==revision||card.hash!==hash(card.payload)||card.hash!==hash(payload(card.invoice,revision)))throw Error('INVALID_APPROVAL_CARD');
  }catch{throw Error('INVALID_APPROVAL_CARD');}
  // Preserve an existing absolute deadline; execution rechecks it after reservation locking.
  const id=randomUUID();
  db.prepare('INSERT INTO approvals(id,payload_hash,expires) VALUES(?,?,?)').run(id,card.hash,expires);
  audit('MOCK_APPROVED',{id,actor,hash:card.hash});return {id,hash:card.hash};
 }
 async function execute(inv,ctx,approval,agent){
  let request;
  try{
   const m=master(ctx),p=payload(inv,m.revision),digest=hash(p),req='pp-'+digest;
   if(!approval?.id)return block('APPROVAL_MISSING');
   const a=db.prepare('SELECT * FROM approvals WHERE id=?').get(approval.id);
   if(!a||approval.hash!==digest||a.payload_hash!==digest)return block('HASH_MISMATCH');
   if(agent?.decision!=='PAY')return {verdict:'HOLD',reasons:['AGENT_NOT_PAY'],deliveryCount:0};
   if(a.expires<=Date.now())return block('APPROVAL_EXPIRED');
   // Re-check immutable facts even on replay, but replay precedes consumed-PO lookup.
   const g=gate(copy(inv),{...ctx,vendors:m.vendors},new Set());
   if(g.verdict!=='PASS')return block(...g.reasons);
   if(p.currency!=='USD')return block('CURRENCY_UNSUPPORTED');
   db.exec('BEGIN IMMEDIATE');
   if(db.prepare('SELECT revision FROM vendor_master WHERE id=1').get().revision!==m.revision){db.exec('ROLLBACK');return block('VENDOR_REVISION_CHANGED');}
   const prior=db.prepare('SELECT * FROM payouts WHERE req_id=?').get(req);
   if(prior){
    db.exec('COMMIT');
    if(prior.status==='SUCCEEDED')return {verdict:'REPLAY',batchId:prior.batch_id,deliveryCount:0};
    return {verdict:'HOLD',reasons:['OUTCOME_REVIEW_REQUIRED'],deliveryCount:0};
   }
   const fresh=db.prepare('SELECT * FROM approvals WHERE id=?').get(a.id);
   if(fresh.used||fresh.expires<=Date.now()){db.exec('ROLLBACK');return block('APPROVAL_USED_OR_EXPIRED');}
   const po=p.po?db.prepare('SELECT * FROM payouts WHERE po=?').get(p.po):null;
   if(po){db.exec('ROLLBACK');return block(po.status==='SUCCEEDED'?'PO_ALREADY_BILLED':'PO_RESERVED');}
   if(db.prepare('SELECT 1 FROM payouts WHERE invoice_no=?').get(p.invoice)){db.exec('ROLLBACK');return block('DUPLICATE');}
   // Old payouts contain only hashes, not recoverable vendor/amount facts. Never
   // infer zero exposure: any unaccounted old row blocks all new reservations.
   if(db.prepare('SELECT 1 FROM payouts p LEFT JOIN payout_exposure e ON e.req_id=p.req_id WHERE e.req_id IS NULL LIMIT 1').get()){
    db.exec('ROLLBACK');return block('VENDOR_EXPOSURE_UNKNOWN');
   }
   const amount=cents(p.amount),limit=cents(m.vendors.find(v=>v.name===p.vendor)?.max);
   if(amount===null||limit===null){db.exec('ROLLBACK');return block('VENDOR_CAP_INVALID');}
   // All persisted statuses retain exposure, with no time reset or automatic release.
   const spent=db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM payout_exposure WHERE vendor=?').get(p.vendor).cents;
   if(!Number.isSafeInteger(spent)||amount>limit-spent){db.exec('ROLLBACK');return block('VENDOR_CUMULATIVE_CAP');}
   db.prepare("INSERT INTO payouts VALUES(?,?,?,?, 'RESERVED',NULL,?)").run(req,digest,p.po||null,p.invoice,a.id);
   db.prepare('INSERT INTO payout_exposure(req_id,vendor,amount_cents) VALUES(?,?,?)').run(req,p.vendor,amount);
   db.prepare('UPDATE approvals SET used=1 WHERE id=?').run(a.id);
   audit('RESERVED',{req,po:p.po,invoice:p.invoice});db.exec('COMMIT');request=req;
   const response=await transport({requestId:req,payload:copy(p)});
   if(transportMode==='sandbox'){
    const receipt=/^[A-Za-z0-9-]{1,64}$/.test(response?.batchId??'')?response.batchId:null;
    // A create receipt never establishes item success. Retain all reserved exposure.
    if(receipt&&['ACCEPTED','PENDING'].includes(response.status)){
     db.prepare("UPDATE payouts SET status='UNKNOWN',batch_id=? WHERE req_id=?").run(receipt,req);
     audit('SANDBOX_RECEIPT',{req,batchId:receipt,status:response.status});
     return {verdict:'SANDBOX_'+response.status,batchId:receipt,deliveryCount:null};
    }
    if(response?.status!=='SUCCESS'||!receipt)throw Error('UNCONFIRMED_SANDBOX_OUTCOME');
   }else if(response?.status!=='SUCCESS'||!/^MOCK-[A-Za-z0-9-]+$/.test(response.batchId??''))throw Error('UNCONFIRMED_MOCK_OUTCOME');
   db.prepare("UPDATE payouts SET status='SUCCEEDED',batch_id=? WHERE req_id=?").run(response.batchId,req);
   audit(transportMode==='mock'?'MOCK_SUCCESS':'SANDBOX_ITEM_SUCCESS',{req,batchId:response.batchId});
   return {verdict:transportMode==='mock'?'MOCK_PAID':'SANDBOX_ITEM_SUCCESS',batchId:response.batchId,deliveryCount:1};
  }catch{
   try{db.exec('ROLLBACK');}catch{}
   if(request){db.prepare("UPDATE payouts SET status='UNKNOWN' WHERE req_id=?").run(request);audit('OUTCOME_UNKNOWN',{req:request});}
   return {verdict:'HOLD',reasons:['OUTCOME_REVIEW_REQUIRED'],deliveryCount:request?null:0,transportAttempted:Boolean(request)};
  }
 }
 function requestVendorChange(ctx,{vendor,payee,requester}){
  const m=master(ctx);
  if(!m.vendors.some(v=>v.name===vendor)||typeof payee!=='string'||!payee.endsWith('.example.com')||!requester)throw Error('INVALID_VENDOR_CHANGE');
  const id=randomUUID(),nonce=randomUUID();
  db.prepare('INSERT INTO vendor_changes VALUES(?,?,?,?,?,?,0)').run(id,vendor,payee,m.revision,nonce,requester);
  return {id,confirmationNonce:nonce,requiredChannel:'out-of-band'};
 }
 function confirmVendorChange(ctx,{id,confirmationNonce,confirmer,channel}){
  db.exec('BEGIN IMMEDIATE');
  try{
   const row=db.prepare('SELECT * FROM vendor_changes WHERE id=?').get(id),m=master(ctx);
   if(!row||row.used||row.nonce!==confirmationNonce||row.revision!==m.revision||!confirmer||confirmer===row.requester||channel!=='out-of-band')throw Error('VENDOR_CONFIRMATION_REQUIRED');
   const vendors=m.vendors.map(v=>v.name===row.vendor?{...v,paypal:row.payee}:v);
   db.prepare('UPDATE vendor_master SET revision=revision+1,data=? WHERE id=1').run(JSON.stringify(vendors));
   db.prepare('UPDATE vendor_changes SET used=1 WHERE id=?').run(id);audit('VENDOR_CHANGED',{vendor:row.vendor,confirmer});db.exec('COMMIT');return {changed:true};
  }catch{db.exec('ROLLBACK');return {changed:false,reason:'VENDOR_CONFIRMATION_REQUIRED'};}
 }
 const mockTransport=async({requestId})=>{
  const batch='MOCK-'+hash(requestId).slice(0,16).toUpperCase();
  db.prepare('INSERT INTO mock_deliveries VALUES(?,?)').run(requestId,batch);
  return {status:'SUCCESS',batchId:batch};
 };
 return {proposal,approve,execute,requestVendorChange,confirmVendorChange,mockTransport,
  ledger:()=>db.prepare('SELECT req_id,po,invoice_no,status,batch_id FROM payouts ORDER BY rowid').all(),
  deliveries:()=>Number(db.prepare('SELECT count(*) AS n FROM mock_deliveries').get().n),
  close:()=>db.close()};
}
