// Project copies (draft, backups). localStorage holds what fits, because it
// can still be written while the page closes; its roughly 5 MB cannot hold a
// large project and its backups, so those go to IndexedDB. A key lives in one
// place at a time and localStorage is read first.
let opened;
const db = () => opened ||= new Promise((resolve, reject) => {
  const request = indexedDB.open('mars-trace', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('projects');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function run(mode, action) {
  const tx = (await db()).transaction('projects', mode), request = action(tx.objectStore('projects'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export function put(key, value) {
  const text = JSON.stringify(value);
  try {
    localStorage.setItem(key, text);
    return run('readwrite', s => s.delete(key)).catch(() => {});
  } catch {}
  try { localStorage.removeItem(key); } catch {}
  return run('readwrite', s => s.put(text, key));
}
export async function get(key) {
  let text = null;
  try { text = localStorage.getItem(key); } catch {}
  text ??= await run('readonly', s => s.get(key)).catch(() => null);
  return text == null ? null : JSON.parse(text);
}
export function drop(key) {
  try { localStorage.removeItem(key); } catch {}
  return run('readwrite', s => s.delete(key)).catch(() => {});
}
