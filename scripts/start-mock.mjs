import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseLocalPort} from '../src/web.mjs';

// Only the launcher process environment is scrubbed; the parent shell is unchanged.
// A later smoke may set PROOFPOWERS_PORT to another free port; never kill an unknown process.
export function configureMock({env=process.env,mode='mock'}={}){
 const requested=env.PAYPAL_MODE??'mock';
 for(const key of Object.keys(env))if(/^PAYPAL_/i.test(key))delete env[key];
 if(mode!=='mock'||requested!=='mock')throw Error('MOCK_ONLY: sandbox and other modes are refused');
 return Object.freeze({mode:'mock',env:Object.freeze({}),host:'127.0.0.1',port:parseLocalPort(env.PROOFPOWERS_PORT??4317),filename:fileURLToPath(new URL('../runtime/mock/web.sqlite',import.meta.url))});
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  const config=configureMock();
  if(process.argv.length>2)throw Error('MOCK_ONLY: launcher accepts no mode or other arguments');
  const {startLocalServer}=await import('./local-server.mjs');
  startLocalServer(config);
 }catch(error){console.error(error.message);process.exitCode=1;}
}
