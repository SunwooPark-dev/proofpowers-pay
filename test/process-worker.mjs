import {openPipeline} from '../src/pipeline.mjs';
let app;
process.on('message',async message=>{
 try{
  if(message.command==='prepare'){
   const {db,invoice,ctx}=message;
   app=openPipeline(db,{transport:async r=>{if(message.crashAfterReservation)process.exit(0);await new Promise(resolve=>setTimeout(resolve,80));return app.mockTransport(r);}});
   const agent={decision:'PAY',source:'synthetic concurrency worker'},card=app.proposal(invoice,ctx,agent);
   if(card.verdict!=='APPROVAL_REQUIRED')throw Error('WORKER_GATE_REJECTED');
   app.job={invoice,ctx,agent,approval:app.approve(card,{confirmed:true})};process.send({ready:true});
  }else if(message.command==='go'){
   const j=app.job,result=await app.execute(j.invoice,j.ctx,j.approval,j.agent);app.close();process.send({result});process.disconnect();
  }
 }catch{try{app?.close();}catch{}process.send({error:'WORKER_ERROR'});process.disconnect();}
});
