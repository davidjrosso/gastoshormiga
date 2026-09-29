import { useEffect, useRef, useState } from 'react';
import { useShopping } from './ShoppingProvider';
import { productKey, type ShoppingItem } from '../lib/shopping-model';
import { initialVeaQuantity, useVeaApi, type VeaProduct, type VeaQuote as Quote } from '../lib/vea';
import { money } from '../lib/format';

export default function VeaQuote({ items, onClose }: { items: ShoppingItem[]; onClose: () => void }) {
  const api = useVeaApi(); const { cache, online, error: syncError } = useShopping();
  const searchInput = useRef<HTMLInputElement>(null); const dialog = useRef<HTMLDialogElement>(null); const alive = useRef(true);
  const [quantities, setQuantities] = useState(() => Object.fromEntries(items.map(i => [i.id, String(initialVeaQuantity(i.quantity).qty)])));
  const [selected, setSelected] = useState(() => new Set(items.slice(0, 30).map(i => i.id)));
  const [quote, setQuote] = useState<Quote | null>(null); const [dirty, setDirty] = useState(true);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [now, setNow] = useState(Date.now());
  const [choosing, setChoosing] = useState<ShoppingItem | null>(null); const [term, setTerm] = useState('');
  const [results, setResults] = useState<VeaProduct[] | null>(null);
  const chosen = items.filter(i => selected.has(i.id));
  useEffect(() => { if (choosing) searchInput.current?.focus(); }, [choosing?.id]);
  const signature = JSON.stringify(chosen.map(i => [i.id, i.revision, i.name, i.brand, i.quantity, i.status]));
  const [quotedSignature, setQuotedSignature] = useState('');
  const validQuantities = chosen.every(i => /^\d+$/.test(quantities[i.id] ?? '') && Number(quantities[i.id]) >= 1 && Number(quantities[i.id]) <= 99);
  const canQuery = online && !cache.queue.length && !syncError && chosen.length > 0 && chosen.length <= 30 && validQuantities;
  const fresh = !!quote && !dirty && quotedSignature === signature && now < quote.expiresAt && canQuery && !busy;
  useEffect(() => {
    alive.current = true; dialog.current?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  async function refresh() {
    if (!canQuery) return;
    setBusy(true); setError(''); setDirty(true);
    try {
      const value = await api<Quote>('/quote', 'POST', { items: chosen.map(i => ({ itemId: i.id, qty: Number(quantities[i.id]) })) });
      if (alive.current) { setQuote(value); setDirty(false); setQuotedSignature(signature); setNow(Date.now()); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  // Initial quote; later changes require an explicit recalculation.
  useEffect(() => { void refresh(); }, []);
  async function search() {
    if (term.trim().length < 2 || !online) return;
    setBusy(true); setError(''); setResults(null);
    try { const result = await api<{ products: VeaProduct[] }>(`/search?q=${encodeURIComponent(term.trim())}`); if (alive.current) setResults(result.products); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function link(product: VeaProduct | null, item: ShoppingItem) {
    setBusy(true); setError(''); setDirty(true);
    try {
      await api(`/links/${encodeURIComponent(productKey(item))}`, product ? 'PUT' : 'DELETE', product ? { itemId: item.id, sku: product.sku, packQty: 1 } : undefined);
      if (alive.current) { setChoosing(null); setResults(null); setQuote(null); }
      await refresh();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} aria-label="Cotización VEA" onCancel={onClose} className="fixed inset-0 m-auto max-h-[92dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-2xl bg-white p-4 text-ink shadow-xl backdrop:bg-black/50 dark:bg-slate-900 dark:text-slate-100">
    <header className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Cotizar en VEA</h2><button autoFocus aria-label="Cerrar cotización" className="btn-ghost" onClick={onClose}>Cerrar</button></header>
    <p className="mt-2 text-sm">Vea Río Tercero · retiro en Modesto Acuña 58</p>
    <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">Cotización temporal en pesos. Solo se recuerdan los productos elegidos; no registra precios ni gastos.</p>
    {!online && <p role="alert" className="mt-3 text-sm">Necesitás conexión para cotizar y abrir VEA.</p>}
    {syncError && <p role="alert" className="mt-3 text-sm">{syncError}</p>}
    {!!cache.queue.length && <p role="alert" className="mt-3 text-sm">Primero sincronizá los cambios pendientes de Compras.</p>}
    {items.length > 30 && <p className="mt-3 text-sm">Elegí hasta 30 pendientes por cotización. Seleccionamos los primeros 30 para empezar.</p>}
    {!items.length && <p className="mt-3">No quedan productos pendientes.</p>}
    {error && <p role="alert" className="my-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
    <div className="mt-4 space-y-3">{items.map(item => {
      const row = quote?.rows.find(r => r.itemId === item.id); const offer = quote?.offers.find(o => o.sku === row?.link?.sku);
      return <section key={item.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <h3 className="font-semibold">{item.name}</h3>
        <label className="mt-1 flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={selected.has(item.id)} disabled={busy || (!selected.has(item.id) && chosen.length >= 30)} onChange={e => { const checked = e.target.checked; setSelected(prev => { const next = new Set(prev); if (checked) next.add(item.id); else next.delete(item.id); return next; }); setDirty(true); }} />Incluir en esta cotización</label>
        <label className="mt-2 flex items-center justify-between gap-3 text-sm">Unidades de la presentación VEA
          <input aria-label={`Cantidad VEA de ${item.name}`} type="number" min="1" max="99" step="1" className="input !w-20" value={quantities[item.id] ?? ''} disabled={busy} onChange={e => { setQuantities(q => ({ ...q, [item.id]: e.target.value })); setDirty(true); }} />
        </label>
        {initialVeaQuantity(item.quantity).assumed && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Cantidad original: {item.quantity || 'sin indicar'}. Se propuso 1 unidad; revisala. La lista no se modifica.</p>}
        {row?.link ? <><p className="mt-2 text-sm">{row.link.productName}</p><p className="mt-1 text-sm">{offer?.available ? `${money(offer.unitMinor!)} por unidad · subtotal agrupado abajo` : offer?.reason ?? 'Actualizá la cotización.'}</p></> : <p className="mt-2 text-sm">Elegí el producto de VEA que corresponde.</p>}
        <div className="mt-2 flex gap-3 text-sm"><button className="min-h-10 underline" disabled={busy || !online || !!cache.queue.length} onClick={() => { setChoosing(item); setTerm([item.name, item.brand].filter(Boolean).join(' ').slice(0, 120)); setResults(null); setError(''); }}>{row?.link ? 'Cambiar producto' : 'Elegir producto'}</button>
          {row?.link && <button className="min-h-10 underline" disabled={busy || !online} onClick={() => void link(null, item)}>Quitar vínculo</button>}</div>
      </section>;
    })}</div>
    {choosing && <section className="mt-4 rounded-xl border-2 border-emerald-600 p-3" aria-label={`Buscar producto para ${choosing.name}`}>
      <h3 className="font-semibold">Elegir para {choosing.name}</h3>
      <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); void search(); }}><input ref={searchInput} className="input min-w-0 flex-1" aria-label="Buscar en VEA" maxLength={120} value={term} onChange={e => { setTerm(e.target.value); setResults(null); }} disabled={busy} /><button className="btn-primary" disabled={busy || !online || term.trim().length < 2}>Buscar</button></form>
      {results?.length === 0 && <p className="mt-2 text-sm">No se encontraron productos. Probá otro nombre.</p>}
      <ul className="mt-2 space-y-2">{results?.map(p => <li key={p.sku} className="rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800"><p>{p.productName}</p><p className="mt-1">{!p.supported ? 'Presentación por peso o fraccionada: consultala en VEA.' : p.offer?.available ? `${money(p.offer.unitMinor!)} · retiro disponible` : p.offer?.reason ?? 'Sin cotización'}</p><button className="btn-ghost mt-2 text-sm" disabled={busy || !p.supported || !online} onClick={() => void link(p, choosing)}>Recordar este producto</button></li>)}</ul>
      <button className="mt-2 min-h-10 text-sm underline" disabled={busy} onClick={() => setChoosing(null)}>Cerrar buscador</button>
    </section>}
    <footer className="mt-4 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700">
      {!validQuantities && <p role="alert" className="text-sm">Las cantidades deben ser enteros de 1 a 99.</p>}
      <button className="btn-primary w-full" disabled={busy || !canQuery} onClick={() => void refresh()}>{busy ? 'Consultando VEA…' : 'Actualizar cotización'}</button>
      {quote && <>
        <p className="text-xs">Consultada: {new Date(quote.quotedAt).toLocaleTimeString('es-AR')}. Vigencia máxima: 2 minutos.</p>
        {!fresh && <p role="status" className="text-sm font-semibold">Actualizá la cotización antes de abrir el carrito.</p>}
        {fresh && <><ul className="space-y-2 text-sm">{quote.offers.filter(o => o.available).map(o => <li key={o.sku}><span>{quote.rows.find(r => r.link?.sku === o.sku)?.link?.productName} × {o.qty}</span><strong className="ml-2">{money(o.subtotalMinor!)}</strong></li>)}</ul>
          <p className="font-bold">Total de productos disponibles: {money(quote.totalMinor)}</p>
          <p className="text-sm">Productos distintos en el carrito: {quote.offers.filter(o => o.available).length}. Las presentaciones repetidas suman sus unidades.</p>
          <p className="text-sm">Pendientes excluidos por falta de vínculo, stock o retiro confirmado: {quote.rows.filter(r => !r.link || !quote.offers.find(o => o.sku === r.link?.sku)?.available).length}.</p></>}
        {fresh && quote.cartUrl && <a className="btn-primary block text-center !bg-emerald-600" href={quote.cartUrl} target="_blank" rel="noopener noreferrer" onClick={e => { if (Date.now() >= quote.expiresAt || !navigator.onLine) { e.preventDefault(); setDirty(true); } }}>Abrir carrito en VEA</a>}
      </>}
      <p className="text-xs text-ink-mute dark:text-slate-400">VEA puede conservar productos que ya tenías en el carrito. Revisá cantidades, promociones, cargos, sucursal y retiro antes de pagar allí. Abrir el carrito no marca Comprado en Hormiga.</p>
    </footer>
  </dialog>;
}
