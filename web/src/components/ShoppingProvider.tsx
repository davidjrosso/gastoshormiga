import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Me } from '../lib/api';
import { acceptSnapshot, emptyCache, visibleItems, type ShoppingCache, type ShoppingOperation, type ShoppingSnapshot } from '../lib/shopping-model';
import { updateShopping } from '../lib/shopping-storage';

interface ShoppingContextValue {
  cache: ShoppingCache; ready: boolean; online: boolean; syncing: boolean; error: string;
  enqueue: (operations: ShoppingOperation[]) => Promise<void>;
  resolve: (operationId: string, keepMine: boolean) => Promise<void>;
  sync: () => void;
}
const Context = createContext<ShoppingContextValue | null>(null);
export const useShopping = () => useContext(Context)!;
const baseUrl = `${import.meta.env.BASE_URL}api/shopping`;

export default function ShoppingProvider({ me, children }: { me: Me; children: ReactNode }) {
  const scope = `${me.household.id}:${me.user.id}`;
  const [cache, setCache] = useState(emptyCache);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const running = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const syncRef = useRef<() => void>(() => {});
  const publish = useCallback(async () => {
    const saved = await updateShopping(scope);
    if (alive.current) { setCache(saved); setReady(true); }
    return saved;
  }, [scope]);

  const sync = useCallback(async () => {
    if (running.current || !navigator.onLine || !alive.current) return;
    running.current = true; setSyncing(true);
    const perform = async () => {
      if (!alive.current) return;
      const request = async (op?: ShoppingOperation) => {
        const response = await fetch(op ? `${baseUrl}/operations` : baseUrl, {
          method: op ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Hormiga-Household': me.household.id, 'X-Hormiga-User': me.user.id },
          body: op ? JSON.stringify(op) : undefined,
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 401 || response.status === 403) {
          window.dispatchEvent(new Event('hormiga-session-expired'));
          throw new Error('Volvé a ingresar para sincronizar. Tus cambios están guardados en este dispositivo.');
        }
        const body = await response.json();
        if (!response.ok && ![400, 404, 409].includes(response.status)) throw new Error('No se pudo sincronizar. Reintentaremos automáticamente.');
        return { response, body };
      };
      const initial = await request();
      if (!initial.response.ok) throw new Error('No se pudo cargar la lista');
      await updateShopping(scope, c => { acceptSnapshot(c, initial.body as ShoppingSnapshot); c.syncedAt = Date.now(); });
      while (alive.current) {
        const saved = await updateShopping(scope);
        const blocked = new Set(saved.queue.filter(q => q.error).map(q => q.operation.itemId));
        const entry = saved.queue.find(q => !q.error && !blocked.has(q.operation.itemId));
        if (!entry) break;
        const { response, body } = await request(entry.operation);
        await updateShopping(scope, c => {
          if (response.ok) {
            acceptSnapshot(c, body as ShoppingSnapshot);
            c.queue = c.queue.filter(q => q.operation.id !== entry.operation.id);
            c.syncedAt = Date.now();
          } else {
            if (body.snapshot) acceptSnapshot(c, body.snapshot as ShoppingSnapshot);
            const found = c.queue.find(q => q.operation.id === entry.operation.id);
            if (found) found.error = body.error ?? 'Revisá este cambio';
          }
        });
      }
      if (alive.current) { setOnline(true); setError(''); }
    };
    try {
      if (navigator.locks) await navigator.locks.request(`shopping:${scope}`, perform);
      else await perform();
    } catch (e) {
      if (alive.current) {
        setOnline(navigator.onLine);
        setError(e instanceof Error && !(e instanceof TypeError) ? e.message : 'Sin conexión con el servidor. Los cambios quedan guardados aquí.');
      }
    } finally {
      try { await publish(); channel.current?.postMessage('changed'); } catch { if (alive.current) setError('No se puede guardar la lista en este dispositivo.'); }
      running.current = false;
      if (alive.current) setSyncing(false);
    }
  }, [scope, me.household.id, me.user.id, publish]);
  syncRef.current = () => { void sync(); };

  useEffect(() => {
    alive.current = true;
    publish().then(() => syncRef.current()).catch(() => setError('No se puede abrir el almacenamiento local. Habilitalo para usar Compras.'));
    const connectionChanged = () => { setOnline(navigator.onLine); syncRef.current(); };
    const visibility = () => { if (document.visibilityState === 'visible') syncRef.current(); };
    window.addEventListener('online', connectionChanged); window.addEventListener('offline', connectionChanged);
    document.addEventListener('visibilitychange', visibility);
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') syncRef.current(); }, 10000);
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel(`shopping:${scope}`);
      channel.current.onmessage = () => { void publish().catch(() => {}); };
    }
    return () => {
      alive.current = false; window.clearInterval(interval);
      window.removeEventListener('online', connectionChanged); window.removeEventListener('offline', connectionChanged);
      document.removeEventListener('visibilitychange', visibility);
      channel.current?.close(); channel.current = null;
    };
  }, [scope, publish]);

  const enqueue = async (operations: ShoppingOperation[]) => {
    if (!ready) throw new Error('Esperá a que se abra el almacenamiento local.');
    const saved = await updateShopping(scope, c => {
      c.queue.push(...operations.map(operation => ({ operation, createdAt: Date.now() })));
    });
    if (alive.current) { setCache(saved); channel.current?.postMessage('changed'); syncRef.current(); }
  };
  const resolve = async (id: string, keepMine: boolean) => {
    const saved = await updateShopping(scope, c => {
      const entry = c.queue.find(q => q.operation.id === id);
      if (!entry) return;
      const op = entry.operation;
      const current = c.snapshot.items.find(i => i.id === op.itemId);
      if (!keepMine) {
        // Later edits to this item may depend on the rejected change. Keep them visible for review.
        c.queue = c.queue.filter(q => q.operation.id !== id);
        for (const later of c.queue.filter(q => q.operation.itemId === op.itemId)) later.error = 'Revisá este cambio después de conservar la versión compartida.';
      } else {
        if (op.kind !== 'patch' || !current) throw new Error('Conservá la versión compartida y volvé a agregar el producto.');
        if (op.values.batchId && current.status !== 'bought') throw new Error('El producto volvió a estar pendiente. Conservá la versión compartida antes de marcarlo como comprado.');
        op.id = crypto.randomUUID();
        for (const key of Object.keys(op.base)) Object.assign(op.base, { [key]: current[key as keyof typeof current] });
        // Archived products must be restored explicitly, not silently overwritten.
        if (current.batchId && !op.values.batchId) op.values.batchId = '';
        delete entry.error;
      }
    });
    if (alive.current) { setCache(saved); channel.current?.postMessage('changed'); syncRef.current(); }
  };
  return <Context.Provider value={{ cache, ready, online, syncing, error, enqueue, resolve, sync: () => syncRef.current() }}>{children}</Context.Provider>;
}

export function ShoppingCount() {
  const { cache } = useShopping();
  const count = visibleItems(cache).filter(i => !i.batchId && i.status !== 'bought').length;
  return count > 0 ? <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-xs font-bold text-emerald-800">{count}</span> : null;
}
