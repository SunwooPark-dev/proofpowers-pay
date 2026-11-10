const deny=()=>{throw new Error('OFFLINE_NETWORK_DENIED');};
globalThis.fetch=deny;
for(const name of ['node:net','node:http','node:https','node:dgram','node:tls']){
 const m=require(name);
 for(const k of ['connect','createConnection','request','get','createSocket','createServer'])if(typeof m[k]==='function')m[k]=deny;
 if(m.Socket?.prototype)m.Socket.prototype.connect=deny;
}
require('node:module').syncBuiltinESMExports();
