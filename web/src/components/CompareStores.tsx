import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useShopping } from './ShoppingProvider';
import { productKey, type ShoppingItem } from '../lib/shopping-model';
import { initialVeaQuantity } from '../lib/vea-quantity';
import { useShoppingApi, type Comparison, type MlProduct } from '../lib/ml';
import { money } from '../lib/format';

const price = (minor: number | null | undefined) => minor === null || minor === undefined ? '—' : money(minor);

function CartLink({ href, label, fresh, expiresAt, onStale }: { href: string | null; label: string; fresh: boolean; expiresAt: number; onStale: () => void }) {
  if (!href) return null;
  if (!fresh) return <button className="btn-ghost w-full" disabled>{label} · actualizá primero</button>;
  return <a className="btn-primary block text-center !bg-emerald-600" href={href} target="_blank" rel="noopener noreferrer"
    onClick={e => { if (!fresh || Date.now() >= expiresAt || !navigator.onLine) { e.preventDefault(); onStale(); } }}>{label}</a>;
}

export default function CompareStores({ items, onClose }: { items: ShoppingItem[]; onClose: () => void }) {
  const api = useShoppingApi('las tiendas'); const { cache, online, error: syncError } = useShopping();
  const dialog = useRef<HTMLDialogElement>(null); const alive = useRef(true); const searchInput = useRef<HTMLInputElement>(null);
  const [quantities, setQuantities] = useState(() => Object.fromEntries(items.map(i => [i.id, String(initialVeaQuantity(i.quantity).qty)])));
  const [selected, setSelected] = useState(() => new Set(items.slice(0, 30).map(i => i.id)));
  const [data, setData] = useState<Comparison | null>(null); const [dirty, setDirty] = useState(true);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [now, setNow] = useState(Date.now());
  const [choosing, setChoosing] = useState<ShoppingItem | null>(null); const [term, setTerm] = useState('');
  const [results, setResults] = useState<MlProduct[] | null>(null);
  const chosen = items.filter(i => selected.has(i.id));
  const signature = JSON.stringify(chosen.map(i => [i.id, i.revision, i.name, i.brand, quantities[i.id]]));
  const [comparedSignature, setComparedSignature] = useState('');
  const validQuantities = chosen.every(i => /^\d+$/.test(quantities[i.id] ?? '') && Number(quantities[i.id]) >= 1 && Number(quantities[i.id]) <= 99);
  const canQuery = online && !cache.queue.length && !syncError && chosen.length > 0 && chosen.length <= 30 && validQuantities;
  const fresh = !!data && !dirty && comparedSignature === signature && now < data.expiresAt && canQuery && !busy;
  useEffect(() => {
    alive.current = true; dialog.current?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => { if (choosing) searchInput.current?.focus(); }, [choosing?.id]);
  async function compare() {
    if (!canQuery) return;
    setBusy(true); setError(''); setDirty(true);
    try {
      const value = await api<Comparison>('/compare', 'POST', { items: chosen.map(i => ({ itemId: i.id, qty: Number(quantities[i.id]) })) });
      if (alive.current) { setData(value); setDirty(false); setComparedSignature(signature); setNow(Date.now()); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  // Primera comparación al abrir; después se recalcula a pedido.
  useEffect(() => { void compare(); }, []);
  async function search() {
    if (term.trim().length < 2 || !online) return;
    setBusy(true); setError(''); setResults(null);
    try { const r = await api<{ products: MlProduct[] }>(`/stores/ml/search?q=${encodeURIComponent(term.trim())}`); if (alive.current) setResults(r.products); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function link(product: MlProduct | null, item: ShoppingItem) {
    setBusy(true); setError('');
    try {
      await api(`/stores/ml/links/${encodeURIComponent(productKey(item))}`, product ? 'PUT' : 'DELETE', product ? { itemId: item.id, productId: product.productId } : undefined);
      if (alive.current) { setChoosing(null); setResults(null); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
    await compare();
  }
  const s = data?.summary;
  return <dialog ref={dialog} aria-label="Comparar VEA y Mercado Libre" onCancel={onClose} className="fixed inset-0 m-auto max-h-[92dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-2xl bg-white p-4 text-ink shadow-xl backdrop:bg-black/50 dark:bg-slate-900 dark:text-slate-100">
    <header className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Comparar VEA y Mercado Libre</h2><button autoFocus aria-label="Cerrar comparación" className="btn-ghost" onClick={onClose}>Cerrar</button></header>
    <p className="mt-2 text-sm">VEA Río Tercero con retiro (sin costo) · Mercado Libre solo Full.</p>
    <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">Compará la misma marca, tamaño y presentación. ML confirma stock, envío y cantidad de paquetes en su checkout. Estos precios temporales no registran gastos.</p>
    {!online && <p role="alert" className="mt-3 text-sm">Necesitás conexión para comparar.</p>}
    {syncError && <p role="alert" className="mt-3 text-sm">{syncError}</p>}
    {!!cache.queue.length && <p role="alert" className="mt-3 text-sm">Primero sincronizá los cambios pendientes de Compras.</p>}
    {items.length > 30 && <p className="mt-3 text-sm">Elegí hasta 30 pendientes por comparación. Seleccionamos los primeros 30.</p>}
    {error && <p role="alert" className="my-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
    {data?.veaError && <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">VEA: {data.veaError}</p>}
    {data?.mlError && <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Mercado Libre: {data.mlError}{data.mlReconnect && <> <Link className="underline" to="/ajustes" onClick={onClose}>Ir a Ajustes</Link></>}</p>}

    <div className="mt-4 space-y-3">{items.map(item => {
      const row = data?.rows.find(r => r.itemId === item.id); const pick = fresh ? s?.choices[item.id] : null;
      return <section key={item.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <h3 className="font-semibold">{item.name}</h3>
        <label className="mt-1 flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={selected.has(item.id)} disabled={busy || (!selected.has(item.id) && chosen.length >= 30)} onChange={e => { const checked = e.target.checked; setSelected(prev => { const next = new Set(prev); if (checked) next.add(item.id); else next.delete(item.id); return next; }); setDirty(true); }} />Incluir</label>
        {initialVeaQuantity(item.quantity).assumed && <p className="text-xs">Revisá las unidades de esta presentación antes de comparar.</p>}
        <label className="mt-1 flex items-center justify-between gap-3 text-sm">Unidades
          <input aria-label={`Cantidad de ${item.name}`} type="number" min="1" max="99" step="1" className="input !w-20" value={quantities[item.id] ?? ''} disabled={busy} onChange={e => { setQuantities(q => ({ ...q, [item.id]: e.target.value })); setDirty(true); }} />
        </label>
        {row && <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <div className={`rounded-lg p-2 ${pick === 'vea' ? 'bg-emerald-50 ring-2 ring-emerald-600 dark:bg-emerald-950' : 'bg-slate-50 dark:bg-slate-800'}`}>
            <p className="text-xs font-semibold">VEA{pick === 'vea' && ' · menor subtotal'}</p>
            {row.vea ? <><p className="mt-1 text-xs">{row.vea.productName}</p><p className="mt-1 font-semibold">{row.vea.available ? price(row.vea.subtotalMinor) : row.vea.reason}</p></> : <p className="mt-1 text-xs">Sin producto elegido: vinculalo desde “Cotizar en VEA”.</p>}
          </div>
          <div className={`rounded-lg p-2 ${pick === 'ml' ? 'bg-emerald-50 ring-2 ring-emerald-600 dark:bg-emerald-950' : 'bg-slate-50 dark:bg-slate-800'}`}>
            <p className="text-xs font-semibold">Mercado Libre Full{pick === 'ml' && ' · menor subtotal'}</p>
            {row.ml ? <><p className="mt-1 text-xs">{row.ml.productName}</p><p className="mt-1 font-semibold">{row.ml.subtotalMinor !== null ? price(row.ml.subtotalMinor) : row.ml.reason}</p>
              {row.ml.subtotalMinor !== null && <p className="text-xs">Stock y envío a confirmar en ML.</p>}</>
              : <p className="mt-1 text-xs">Sin producto elegido.</p>}
          </div>
        </div>}
        <div className="mt-2 flex gap-3 text-sm"><button className="min-h-10 underline" disabled={busy || !online || !!cache.queue.length} onClick={() => { setChoosing(item); setTerm([item.name, item.brand].filter(Boolean).join(' ').slice(0, 120)); setResults(null); setError(''); }}>{row?.ml ? 'Cambiar en ML' : 'Elegir en ML'}</button>
          {row?.ml && <button className="min-h-10 underline" disabled={busy || !online} onClick={() => void link(null, item)}>Quitar de ML</button>}</div>
      </section>;
    })}</div>

    {choosing && <section className="mt-4 rounded-xl border-2 border-emerald-600 p-3" aria-label={`Buscar en Mercado Libre para ${choosing.name}`}>
      <h3 className="font-semibold">Elegir en Mercado Libre para {choosing.name}</h3>
      <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); void search(); }}><input ref={searchInput} className="input min-w-0 flex-1" aria-label="Buscar en Mercado Libre" maxLength={120} value={term} onChange={e => { setTerm(e.target.value); setResults(null); }} disabled={busy} /><button className="btn-primary" disabled={busy || !online || term.trim().length < 2}>Buscar</button></form>
      {results?.length === 0 && <p className="mt-2 text-sm">No se encontraron productos. Probá otro nombre.</p>}
      <ul className="mt-2 space-y-2">{results?.map(p => <li key={p.productId} className="rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800"><p>{p.productName}</p>
        <p className="mt-1">{p.offer ? `${money(p.offer.unitMinor)} Full · ${p.offer.freeShipping ? 'envío gratis' : `envío ${price(p.offer.shippingMinor)}`}` : p.reason}</p>
        <button className="btn-ghost mt-2 text-sm" disabled={busy || !online || !p.offer} onClick={() => void link(p, choosing)}>Recordar este producto</button></li>)}</ul>
      <button className="mt-2 min-h-10 text-sm underline" disabled={busy} onClick={() => setChoosing(null)}>Cerrar buscador</button>
    </section>}

    <footer className="mt-4 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700">
      {!validQuantities && <p role="alert" className="text-sm">Las cantidades deben ser enteros de 1 a 99.</p>}
      <button className="btn-primary w-full" disabled={busy || !canQuery} onClick={() => void compare()}>{busy ? 'Consultando tiendas…' : 'Actualizar comparación'}</button>
      {data && s && <>
        <p className="text-xs">Consultada: {new Date(data.quotedAt).toLocaleTimeString('es-AR')}. Vigencia máxima: 2 minutos.</p>
        {!fresh && <p role="status" className="text-sm font-semibold">Actualizá la comparación antes de abrir un carrito.</p>}
        <div className="grid gap-2">
          <article className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><h3 className="font-semibold">Todo en VEA (retiro)</h3>
            <p className="text-lg font-bold">{money(s.vea.totalMinor)}</p><p className="text-xs">Faltan {s.vea.missing} de {data.rows.length}.</p>
            <div className="mt-2"><CartLink href={data.carts.vea} label="Abrir carrito VEA" fresh={fresh} expiresAt={data.expiresAt} onStale={() => setDirty(true)} /></div></article>
          <article className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><h3 className="font-semibold">Todo en Mercado Libre (Full)</h3>
            <p className="text-lg font-bold">{s.ml.totalMinor === null ? `${money(s.ml.productsMinor)} + envío` : money(s.ml.totalMinor)}</p>
            <p className="text-xs">Productos {money(s.ml.productsMinor)} · envío conjunto {s.ml.shippingMinor === null ? 'a confirmar en ML' : money(s.ml.shippingMinor)}. Faltan {s.ml.missing} de {data.rows.length}.</p>
            <div className="mt-2"><CartLink href={data.carts.ml} label="Abrir carrito Mercado Libre" fresh={fresh} expiresAt={data.expiresAt} onStale={() => setDirty(true)} /></div></article>
          <article className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><h3 className="font-semibold">Mixto sugerido por precio de productos</h3>
            <p className="text-lg font-bold">{s.mixed.totalMinor === null ? `${price(s.mixed.productsMinor)} + envío` : price(s.mixed.totalMinor)}</p>
            <p className="text-xs">La parte VEA se cotiza nuevamente; el mixto puede no ser la opción más barata.</p>
            {data.mixedError && <p role="alert" className="text-sm">{data.mixedError}</p>}
            <p className="text-xs">{s.mixed.veaCount} en VEA · {s.mixed.mlCount} en ML{s.mixed.mlCount ? ` · envío conjunto ${s.mixed.shippingMinor === null ? 'a confirmar en ML' : money(s.mixed.shippingMinor)}` : ''}. Faltan {s.mixed.missing}.</p>
            <div className="mt-2 space-y-2"><CartLink href={data.carts.mixedVea} label="Abrir carrito VEA (parte mixta)" fresh={fresh} expiresAt={data.expiresAt} onStale={() => setDirty(true)} /><CartLink href={data.carts.mixedMl} label="Abrir carrito ML (parte mixta)" fresh={fresh} expiresAt={data.expiresAt} onStale={() => setDirty(true)} /></div></article>
        </div>
      </>}
      <p className="text-xs text-ink-mute dark:text-slate-400">Las tiendas pueden conservar productos que ya tenías en el carrito. Revisá precio, envío, retiro y cantidades antes de pagar. Abrir un carrito no marca Comprado en Hormiga.</p>
    </footer>
  </dialog>;
}
