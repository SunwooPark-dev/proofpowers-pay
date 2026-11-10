import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openPipeline} from '../src/pipeline.mjs';
import {createSandboxTransport,sandboxReadiness} from '../src/paypal-sandbox.mjs';
const mode=process.env.PAYPAL_MODE??'mock';
const readiness=sandboxReadiness(process.env);
if(mode!=='sandbox'||!readiness.ready){
 console.error('HOLD',JSON.stringify({mode,blockers:[...(mode==='sandbox'?[]:['SANDBOX_MODE_REQUIRED']),...readiness.blockers],credentialValidation:'Separate owner/coordinator validation required; no credential values inspected or printed',receiverValidation:'Explicit PAYPAL_SANDBOX_RECEIVER_EMAIL required; historical fixtures prohibited',calls:0}));
 process.exitCode=2;
}else{
 // Explicit invocation only. This synthetic 0.01 USD card uses the exact named receiver.
 const receiver=process.env.PAYPAL_SANDBOX_RECEIVER_EMAIL;
 const inv={vendor:'Explicit sandbox receiver',invoice_no:'SANDBOX-ONE-CENT',po:'SANDBOX-ONE-CENT',pay_to:receiver,amount:'0.01',currency:'USD',notes:'Synthetic CLI sandbox validation; no live agent.'};
 const ctx={vendors:[{name:inv.vendor,paypal:receiver,max:'0.01'}],purchase_orders:[{po:inv.po,vendor:inv.vendor,amount:inv.amount}]};
 const dir=new URL('../step2-evidence/runtime/',import.meta.url);
 mkdirSync(dir,{recursive:true});
 const app=openPipeline(fileURLToPath(new URL('sandbox-validation.sqlite',dir)),{transportMode:'sandbox',transport:createSandboxTransport({mode,env:process.env})});
 try{const agent={decision:'PAY',source:'Synthetic explicitly opted-in CLI validation, not recorded or live agent'},card=app.proposal(inv,ctx,agent);if(card.verdict!=='APPROVAL_REQUIRED'){console.error('HOLD',JSON.stringify({reasons:card.reasons,calls:0}));process.exitCode=2;}else{const approval=app.approve(card,{confirmed:true,actor:'explicit CLI sandbox opt-in; not identity authentication'});console.log(JSON.stringify(await app.execute(inv,ctx,approval,agent)));}console.log('Receipt only; no item SUCCESS claimed. Persistent sandbox-validation ledger retained locally.');}
 catch{console.error('HOLD: LOCAL_REVIEW_REQUIRED');process.exitCode=2;}
 finally{app.close();}
}
