import { emptyCache, type ShoppingCache } from './shopping-model';

let connection: Promise<IDBDatabase> | undefined;
function database() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('hormiga-shopping-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('households');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error('Cerrá las otras pestañas de Hormiga para habilitar el guardado local.'));
  });
}
// A single read/write transaction serializes mutations even across browser tabs.
export async function updateShopping(scope: string, change?: (cache: ShoppingCache) => void): Promise<ShoppingCache> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('households', change ? 'readwrite' : 'readonly');
    const store = tx.objectStore('households');
    const request = store.get(scope);
    let cache: ShoppingCache;
    let failure: unknown;
    request.onsuccess = () => {
      cache = request.result ?? emptyCache();
      try {
        if (change) { change(cache); store.put(cache, scope); }
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(cache);
    tx.onerror = () => reject(failure ?? tx.error);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('No se pudo guardar en este dispositivo'));
  });
}
