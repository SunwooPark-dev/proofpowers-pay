import {Server} from 'node:net';
Server.prototype.listen=()=>{throw Error('OFFLINE_LISTEN');};
globalThis.fetch=()=>{throw Error('OFFLINE_FETCH');};
const {configureMock}=await import('../scripts/start-mock.mjs');
const config=configureMock();
process.send({mode:config.mode,keys:Object.keys(process.env).filter(key=>/^PAYPAL_/i.test(key))});
process.disconnect();
