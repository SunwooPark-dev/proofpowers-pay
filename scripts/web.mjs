import {fileURLToPath} from 'node:url';
import {startLocalServer} from './local-server.mjs';
const mode=process.env.PAYPAL_MODE??'mock';
if(!['mock','sandbox'].includes(mode))throw Error('INVALID_TRANSPORT_MODE');
startLocalServer({filename:fileURLToPath(new URL(`../step2-evidence/runtime/web-${mode}.sqlite`,import.meta.url)),mode,env:process.env,port:process.env.PROOFPOWERS_PORT??4317});
