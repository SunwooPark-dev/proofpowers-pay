// Sandbox only. This module performs no I/O until an explicitly enabled transport is invoked.
const HOST='https://api-m.sandbox.paypal.com';
const email=s=>typeof s==='string'&&s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)&&!/(?:^|\.)example\.com$/i.test(s.split('@')[1]);
export function sandboxReadiness(env={}){
 const blockers=[];
 if(!env.PAYPAL_SANDBOX_CLIENT_ID||!env.PAYPAL_SANDBOX_SECRET)blockers.push('CREDENTIAL_VALIDATION_REQUIRED');
 if(!email(env.PAYPAL_SANDBOX_RECEIVER_EMAIL))blockers.push('RECEIVER_VALIDATION_REQUIRED');
 if(env.PAYPAL_SANDBOX_RUN!=='1')blockers.push('EXPLICIT_RUN_OPT_IN_REQUIRED');
 return {ready:blockers.length===0,blockers};
}
export function createSandboxTransport({mode='mock',env={},fetchImpl=globalThis.fetch}={}){
 const enabled=mode==='sandbox'&&sandboxReadiness(env).ready;
 const attempts=new Map(),receipts=new Map();
 async function call(path,method,authorization,body){
  // Paths are generated here, never supplied by the browser or environment.
  if(!/^\/v1\/(?:oauth2\/token|payments\/payouts(?:\/[A-Za-z0-9-]+)?|payments\/payouts-item\/[A-Za-z0-9-]+)$/.test(path))throw Error('INVALID_PATH');
  const r=await fetchImpl(HOST+path,{method,redirect:'error',signal:AbortSignal.timeout(8000),headers:{Authorization:authorization,'Content-Type':path.includes('oauth2')?'application/x-www-form-urlencoded':'application/json',Accept:'application/json'},...(body===undefined?{}:{body})});
  if(!r.ok)throw Error('PROVIDER_UNAVAILABLE');
  if(r.body?.getReader){
   const reader=r.body.getReader();let size=0;const chunks=[];
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw Error('RESPONSE_LIMIT');chunks.push(Buffer.from(value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
  }
  const value=await r.json();if(Buffer.byteLength(JSON.stringify(value))>65536)throw Error('RESPONSE_LIMIT');return value;
 }
 async function auth(){const r=await call('/v1/oauth2/token','POST','Basic '+Buffer.from(env.PAYPAL_SANDBOX_CLIENT_ID+':'+env.PAYPAL_SANDBOX_SECRET).toString('base64'),'grant_type=client_credentials');if(typeof r.access_token!=='string'||!/^[A-Za-z0-9._~-]{1,4096}$/.test(r.access_token))throw Error('AUTH_FAILED');return 'Bearer '+r.access_token;}
 const valid=r=>r&&/^pp-[a-f0-9]{64}$/.test(r.requestId)&&r.payload?.currency==='USD'&&/^\d{1,7}\.\d{2}$/.test(r.payload.amount)&&Number(r.payload.amount)>0&&r.payload.payee===env.PAYPAL_SANDBOX_RECEIVER_EMAIL;
 const transport=async request=>{
  if(!enabled||!valid(request))return {status:'HOLD'};
  const key=request.requestId,frozen=JSON.parse(JSON.stringify(request));
  if(attempts.has(key))return attempts.get(key);
  const work=(async()=>{try{
   const authorization=await auth();
   const body={sender_batch_header:{sender_batch_id:'pp-'+key.slice(3,30)},items:[{recipient_type:'EMAIL',amount:{value:frozen.payload.amount,currency:'USD'},receiver:frozen.payload.payee,sender_item_id:'item-1'}]};
   const r=await call('/v1/payments/payouts','POST',authorization,JSON.stringify(body));
   const id=r.batch_header?.payout_batch_id;
   if(typeof id!=='string'||! /^[A-Za-z0-9-]{1,64}$/.test(id))return {status:'UNKNOWN'};
   receipts.set(id,{request:frozen,authorization});
   return {status:'ACCEPTED',batchId:id};
  }catch{return {status:'UNKNOWN'};}})();
  attempts.set(key,work);return work;
 };
 transport.verify=async ({batchId,requestId,payload}={})=>{
  const saved=receipts.get(batchId);
  if(!enabled||!saved||saved.request.requestId!==requestId||JSON.stringify(saved.request.payload)!==JSON.stringify(payload))return {status:'UNKNOWN'};
  try{
   const batch=await call('/v1/payments/payouts/'+batchId,'GET',saved.authorization);
   if(batch.batch_header?.payout_batch_id!==batchId||!Array.isArray(batch.items)||batch.items.length!==1)return {status:'UNKNOWN'};
   const id=batch.items[0].payout_item_id;
   if(typeof id!=='string'||! /^[A-Za-z0-9-]{1,64}$/.test(id))return {status:'UNKNOWN'};
   const item=await call('/v1/payments/payouts-item/'+id,'GET',saved.authorization),p=item.payout_item;
   if(item.payout_item_id!==id||p?.sender_item_id!=='item-1'||p.receiver!==payload.payee||p.amount?.value!==payload.amount||p.amount?.currency!=='USD')return {status:'UNKNOWN'};
   return {status:item.transaction_status==='SUCCESS'?'SUCCESS':item.transaction_status==='PENDING'?'PENDING':'UNKNOWN',batchId};
  }catch{return {status:'UNKNOWN'};}
 };
 return transport;
}
