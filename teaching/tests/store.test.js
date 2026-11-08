import test from 'node:test';
import assert from 'node:assert/strict';
import {put} from '../ui/store.js';

test('storage fallback preserves the last copy and a newer synchronous save', async () => {
  const local = new Map(), disk = new Map(), pending = [];
  let full = false;
  globalThis.localStorage = {
    setItem(k,v) { if (full) throw Error('quota'); local.set(k,v); },
    removeItem(k) { local.delete(k); },
  };
  const database = {transaction() {
    const actions = [], tx = {objectStore() {return {
      delete(k) { actions.push(()=>disk.delete(k));return {}; },
      put(v,k) { actions.push(()=>disk.set(k,v));return {}; },
    };}};
    pending.push({tx,actions});return tx;
  }};
  globalThis.indexedDB = {open() {
    const request = {result:database};queueMicrotask(()=>request.onsuccess());return request;
  }};
  async function complete(ok=true) {
    while (!pending.length) await new Promise(setImmediate);
    const {tx,actions}=pending.shift();
    if (ok) {actions.forEach(f=>f());tx.oncomplete();}
    else {tx.error=Error('disk full');tx.onabort();}
  }
  let saved=put('draft','old');await complete();await saved;
  full=true;
  saved=put('draft','new');const rejected=assert.rejects(saved);await complete(false);await rejected;
  assert.equal(local.get('draft'),'"old"');
  saved=put('draft','large');await complete();await saved;
  assert.equal(local.has('draft'),false);assert.equal(disk.get('draft'),'"large"');
  // A small new draft can fit while the older fallback transaction is pending.
  saved=put('draft','older pending');
  full=false;const newer=put('draft','newest');
  await complete();await saved;
  assert.equal(local.get('draft'),'"newest"');
  await complete();await newer;assert.equal(disk.has('draft'),false);
});
