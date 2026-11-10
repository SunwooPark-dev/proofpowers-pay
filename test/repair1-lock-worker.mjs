import {workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';

const state=new Int32Array(workerData.shared),db=new DatabaseSync(workerData.filename);
// Handshake avoids a scheduler race: the request continues only once the writer owns the lock.
Atomics.store(state,0,1);Atomics.notify(state,0);
Atomics.wait(state,1,0,5000);
db.exec('BEGIN IMMEDIATE');
Atomics.store(state,0,2);Atomics.notify(state,0);
Atomics.wait(state,1,1,150);
Atomics.store(state,2,workerData.releaseTime);
db.exec('COMMIT');db.close();
