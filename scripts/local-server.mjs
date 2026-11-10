import {createServer} from 'node:http';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createLocalApp,parseLocalPort} from '../src/web.mjs';

export function startLocalServer({filename,mode='mock',env={},port=4317}){
 port=parseLocalPort(port);
 mkdirSync(dirname(filename),{recursive:true});
 const app=createLocalApp({filename,mode,env,port});
 const errorHeaders={'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'};
 const server=createServer(async(req,res)=>{
  let bytes=0;const chunks=[];
  try{
   for await(const chunk of req){bytes+=chunk.length;if(bytes>8192){res.writeHead(413,{...errorHeaders,Connection:'close'});res.end('Body limit');return;}chunks.push(chunk);}
   const result=await app.handle({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString('utf8')});
   res.writeHead(result.status,result.headers);res.end(typeof result.body==='string'?result.body:JSON.stringify(result.body));
  }catch{if(!res.headersSent)res.writeHead(400,errorHeaders);res.end();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;server.timeout=10000;server.maxHeadersCount=40;
 server.on('error',()=>{console.error(`Local server unavailable (port ${port} may be occupied). Choose another free PROOFPOWERS_PORT; do not stop unknown processes.`);app.close();process.exitCode=1;});
 server.listen(port,'127.0.0.1',()=>console.log(`ProofPowers ${mode.toUpperCase()} · http://127.0.0.1:${port} · local unauthenticated demo`));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{app.close();process.exit(0);}));
 return server;
}
