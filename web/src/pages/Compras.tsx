import { useState } from 'react';
import { Check, RotateCcw, ShoppingCart, WifiOff } from 'lucide-react';
import ShoppingEditor from '../components/ShoppingEditor';
import VeaQuote from '../components/VeaQuote';
import CompareStores from '../components/CompareStores';
import { useShopping } from '../components/ShoppingProvider';
import { newProduct, patchOperation, productKey, sections, visibleItems, type ShoppingItem, type ShoppingOperation, type ShoppingValues } from '../lib/shopping-model';

const labels: Record<keyof ShoppingValues, string> = { name: 'Producto', quantity: 'Cantidad', unit: 'Unidad', brand: 'Marca', note: 'Nota', section: 'Rubro', urgent: 'Urgente', status: 'Estado', batchId: 'Historial' };
function display(value: unknown) {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return ({ pending: 'Pendiente', bought: 'Comprado', unavailable: 'No conseguí' } as Record<string, string>)[String(value)] ?? (value || 'Sin dato');
}

export default function Compras() {
  const { cache, ready, online, syncing, error, enqueue, resolve, sync } = useShopping();
  const [editing, setEditing] = useState<ShoppingItem | 'new' | null>(null);
  const [shopping, setShopping] = useState(false);
  const [quoting, setQuoting] = useState(false); const [comparing, setComparing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<ShoppingOperation[] | null>(null);
  const items = visibleItems(cache);
  const active = items.filter(i => !i.batchId);
  const pending = active.filter(i => i.status !== 'bought');
  const bought = active.filter(i => i.status === 'bought');
  const history = new Map<string, ShoppingItem[]>();
  for (const item of items.filter(i => i.batchId)) history.set(item.batchId, [...(history.get(item.batchId) ?? []), item]);
  const batches = [...history.entries()].sort(([a], [b]) => b.localeCompare(a));

  async function act(ops: ShoppingOperation[], reverse: ShoppingOperation[] | null = null) {
    setBusy(true); setMessage('');
    try { await enqueue(ops); setUndo(reverse); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'No se pudo guardar el cambio en este dispositivo.'); }
    finally { setBusy(false); }
  }
  function state(item: ShoppingItem, status: ShoppingItem['status']) {
    void act([patchOperation(item, { status })], [patchOperation({ ...item, status }, { status: item.status })]);
  }
  function archive() {
    const batchId = `${new Date().toISOString()}_${crypto.randomUUID()}`;
    void act(bought.map(i => patchOperation(i, { batchId })), bought.map(i => patchOperation({ ...i, batchId }, { batchId: '' })));
  }
  async function repeat(products: ShoppingItem[]) {
    const keys = new Set(pending.map(productKey));
    const operations: ShoppingOperation[] = [];
    for (const p of products) {
      if (keys.has(productKey(p))) continue;
      keys.add(productKey(p));
      operations.push({ id: crypto.randomUUID(), itemId: crypto.randomUUID(), kind: 'add', values: { ...newProduct(p.name), quantity: p.quantity, unit: p.unit, brand: p.brand, section: p.section, note: p.note } });
    }
    await act(operations);
    setMessage(operations.length ? `${operations.length === 1 ? 'Se agregó 1 producto' : `Se agregaron ${operations.length} productos`}. Los que ya estaban pendientes no se repitieron.` : 'Estos productos ya están pendientes.');
  }
  const row = (item: ShoppingItem) => <li key={item.id} className={`flex items-center gap-3 py-3 ${shopping ? 'min-h-24' : ''}`}>
    <div className="min-w-0 flex-1">
      <button className="w-full break-words text-left" onClick={() => setEditing(item)} aria-label={`Editar ${item.name}`}>
        <span className={`block font-semibold ${item.status === 'bought' ? 'text-ink-mute line-through dark:text-slate-400' : ''}`}>{item.name}</span>
        {(item.quantity || item.unit || item.brand) && <span className="mt-0.5 block text-sm text-ink-mute dark:text-slate-400">{[item.quantity, item.unit, item.brand].filter(Boolean).join(' · ')}</span>}
        {item.note && <span className="mt-1 block whitespace-pre-wrap text-xs text-ink-mute dark:text-slate-400">{item.note}</span>}
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        {item.urgent && item.status !== 'bought' && <span className="font-medium text-amber-700 dark:text-amber-300">Lo necesitamos pronto</span>}
        {item.status !== 'bought' && <button disabled={busy} className="min-h-9 text-ink-mute underline dark:text-slate-400" onClick={() => state(item, item.status === 'unavailable' ? 'pending' : 'unavailable')}>{item.status === 'unavailable' ? 'No conseguí · volver a pendiente' : 'No conseguí'}</button>}
        {cache.queue.some(q => q.operation.itemId === item.id) && <span className="text-amber-700 dark:text-amber-300">{cache.queue.some(q => q.operation.itemId === item.id && q.error) ? 'Revisar cambio' : 'Por sincronizar'}</span>}
      </div>
    </div>
    <button role="checkbox" aria-checked={item.status === 'bought'} aria-label={`Comprado: ${item.name}`} disabled={busy}
      onClick={() => state(item, item.status === 'bought' ? 'pending' : 'bought')}
      className={`flex min-h-14 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 text-xs font-semibold ${item.status === 'bought' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-200 text-ink-mute dark:border-slate-700 dark:text-slate-300'}`}>
      {item.status === 'bought' ? <Check size={22} /> : <span className="h-5 w-5 rounded border-2 border-current" />}
      Comprado
    </button>
  </li>;

  return <div className="space-y-3 p-3 pb-32">
    <header className="flex items-start justify-between gap-3 px-1 pt-2"><div><h1 className="text-xl font-bold">Compras</h1><p className="mt-1 text-sm text-ink-mute dark:text-slate-400">{pending.length} {pending.length === 1 ? 'producto pendiente' : 'productos pendientes'} · lista del hogar</p></div><ShoppingCart className="mt-1 text-emerald-600" size={28} /></header>
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-ink-mute dark:text-slate-400" role="status">
      <span className="flex items-center gap-1">{!online && <WifiOff size={14} />}{!online ? 'Sin conexión · guardamos tus cambios aquí' : syncing ? 'Sincronizando…' : error ? 'Guardada aquí · sin sincronizar con el servidor' : cache.queue.length ? `${cache.queue.length} ${cache.queue.length === 1 ? 'cambio' : 'cambios'} por sincronizar` : cache.syncedAt ? 'Lista sincronizada' : 'Preparando lista…'}</span>
      <button className="min-h-9 underline" disabled={syncing} onClick={sync}>Actualizar</button>
    </div>
    {error && <p role="alert" className="card text-sm text-amber-700 dark:text-amber-300">{error}</p>}
    {message && <p role="status" className="card text-sm">{message}</p>}
    {undo && <div className="card flex items-center justify-between gap-2 text-sm"><span>Cambio guardado</span><button className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300" disabled={busy} onClick={() => void act(undo)}><RotateCcw size={16} />Deshacer</button></div>}
    {cache.queue.filter(q => q.error).map(({ operation: op, error: reason }) => {
      const current = cache.snapshot.items.find(i => i.id === op.itemId);
      return <div key={op.id} role="alert" className="card space-y-2 border border-amber-400 text-sm"><p className="font-semibold">Revisar {current?.name ?? op.values.name ?? 'producto'}</p><p>{reason}</p>
        {Object.entries(op.values).map(([key, value]) => <p key={key} className="break-words">{labels[key as keyof ShoppingValues]}: tu cambio «{String(display(value))}» · compartido «{String(display(current?.[key as keyof ShoppingValues]))}»</p>)}
        {current?.batchId && !op.values.batchId && <p>Aplicar tu cambio devolverá el producto del historial a la lista.</p>}
        <div className="flex flex-wrap gap-2"><button className="btn-ghost text-sm" onClick={() => void resolve(op.id, false).catch(e => setMessage(String(e)))}>Conservar compartido</button>{op.kind === 'patch' && current && (!op.values.batchId || current.status === 'bought') && <button className="btn-primary text-sm" onClick={() => void resolve(op.id, true).catch(e => setMessage(String(e)))}>Aplicar mi cambio</button>}</div>
      </div>;
    })}
    <div className="flex gap-2"><button className="btn-primary flex-1 !bg-emerald-600" disabled={!ready} onClick={() => setEditing('new')}>+ Agregar productos</button><button className="btn-ghost text-sm" aria-pressed={shopping} onClick={() => setShopping(!shopping)}>{shopping ? 'Salir del modo compra' : 'Estoy en el súper'}</button></div>
    {!ready && <p className="card text-sm">Abriendo lista…</p>}
    <div className="flex gap-2"><button className="btn-ghost flex-1" disabled={!ready || !online || !pending.length || !!cache.queue.length || !!error} onClick={() => setQuoting(true)}>Cotizar en VEA</button>
      <button className="btn-ghost flex-1" disabled={!ready || !online || !pending.length || !!cache.queue.length || !!error} onClick={() => setComparing(true)}>Comparar VEA / ML</button></div>
    {quoting && <VeaQuote items={pending} onClose={() => setQuoting(false)} />}
    {comparing && <CompareStores items={pending} onClose={() => setComparing(false)} />}
    {ready && !active.length && <div className="card py-8 text-center"><ShoppingCart className="mx-auto mb-3 text-emerald-600" size={36} /><p className="font-semibold">¿Qué hace falta en casa?</p><p className="mt-1 text-sm text-ink-mute dark:text-slate-400">Agregá productos y compartí la lista con tu hogar.</p></div>}
    {[...new Set([...sections, ...pending.map(p => p.section)])].map(section => {
      const group = pending.filter(p => p.section === section).sort((a,b) => Number(b.urgent) - Number(a.urgent) || a.createdAt - b.createdAt);
      return group.length > 0 && <section key={section} className="card"><h2 className="label">{section} · {group.length}</h2><ul className="divide-y divide-slate-100 dark:divide-slate-800">{group.map(row)}</ul></section>;
    })}
    {bought.length > 0 && <section className="card"><h2 className="label">Comprados · {bought.length}</h2><ul className="divide-y divide-slate-100 dark:divide-slate-800">{bought.map(row)}</ul><button className="btn-ghost mt-3 w-full text-sm" disabled={busy} onClick={archive}>Guardar comprados en el historial</button><p className="mt-2 text-xs text-ink-mute dark:text-slate-400">Solo ordena la lista. Los precios y gastos se registran por separado.</p></section>}
    {batches.length > 0 && <details className="card"><summary className="cursor-pointer font-semibold">Compras anteriores</summary><div className="mt-3 space-y-3">{batches.map(([batch, products]) => <div key={batch} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><p className="text-sm font-medium">{new Date(batch.split('_')[0]).toLocaleDateString('es-AR')} · {products.length} productos</p><p className="my-2 break-words text-sm text-ink-mute dark:text-slate-400">{products.map(p => p.name).join(', ')}</p><button className="text-sm font-semibold text-emerald-700 dark:text-emerald-300" disabled={busy} onClick={() => void repeat(products)}>Repetir esta compra</button></div>)}</div></details>}
    {editing && <ShoppingEditor key={editing === 'new' ? 'new' : editing.id} item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
  </div>;
}
