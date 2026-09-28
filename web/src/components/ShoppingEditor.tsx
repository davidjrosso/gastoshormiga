import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, ShoppingCart } from 'lucide-react';
import { newProduct, patchOperation, productKey, sections, visibleItems, type ShoppingItem, type ShoppingOperation, type ShoppingValues } from '../lib/shopping-model';
import { useShopping } from './ShoppingProvider';

export function ShoppingDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    return () => { previous?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}
    className="m-auto max-h-[90dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-3xl bg-white p-5 text-ink shadow-xl backdrop:bg-black/50 dark:bg-slate-900 dark:text-white">
    <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-lg font-bold">{title}</h2>
      <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-xl p-3"><X size={20} /></button></div>
    {children}
  </dialog>;
}

export default function ShoppingEditor({ item, onClose }: { item?: ShoppingItem; onClose: () => void }) {
  const { cache, enqueue, ready } = useShopping();
  const [values, setValues] = useState<ShoppingValues>(item ?? newProduct(''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const products = visibleItems(cache);
  const frequencies = new Map<string, { item: ShoppingItem; count: number }>();
  for (const product of products.filter(p => p.status === 'bought')) {
    const key = productKey(product);
    const previous = frequencies.get(key);
    frequencies.set(key, { item: product, count: (previous?.count ?? 0) + 1 });
  }
  const frequent = [...frequencies.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  const change = <K extends keyof ShoppingValues>(key: K, value: ShoppingValues[K]) => {
    setValues(v => ({ ...v, [key]: value })); setDuplicates([]);
  };
  async function save(allowDuplicates = false) {
    setError('');
    const names = item ? [values.name.trim()] : values.name.split(/\r?\n/).map(n => n.trim().replace(/^[-•]\s*/, '')).filter(Boolean);
    if (!names.length || names.some(n => n.length > 120) || names.length > 100) { setError('Ingresá hasta 100 productos, con un nombre de hasta 120 caracteres por renglón.'); return; }
    const pending = new Set(products.filter(p => !p.batchId && p.status !== 'bought' && p.id !== item?.id).map(productKey));
    const repeated: string[] = [];
    for (const name of names) {
      const key = productKey({ name, brand: values.brand });
      if (pending.has(key)) repeated.push(name);
      pending.add(key);
    }
    if (repeated.length && !allowDuplicates) { setDuplicates([...new Set(repeated)]); return; }
    setSaving(true);
    try {
      let operations: ShoppingOperation[];
      if (item) {
        const changed: Partial<ShoppingValues> = {};
        for (const key of ['name','quantity','unit','brand','note','section','urgent'] as const) {
          const value = typeof values[key] === 'string' ? (values[key] as string).trim() : values[key];
          if (value !== item[key]) Object.assign(changed, { [key]: value });
        }
        operations = Object.keys(changed).length ? [patchOperation(item, changed)] : [];
      } else {
        operations = names.map(name => ({ id: crypto.randomUUID(), itemId: crypto.randomUUID(), kind: 'add', values: { ...newProduct(name), quantity: values.quantity.trim(), unit: values.unit.trim(), brand: values.brand.trim(), note: values.note.trim(), section: values.section, urgent: values.urgent } }));
      }
      await enqueue(operations); onClose();
    } catch { setError('No se pudo guardar en este dispositivo. La lista no se modificó; reintentá.'); }
    finally { setSaving(false); }
  }
  return <ShoppingDialog title={item ? 'Editar producto' : 'Agregar a Compras'} onClose={onClose}>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label className="block text-sm font-medium">{item ? 'Producto' : 'Producto o varios, uno por renglón'}
        <textarea autoFocus required rows={item ? 1 : 3} maxLength={12500} className="input mt-1" value={values.name} onChange={e => change('name', e.target.value)} placeholder="Leche&#10;Pan&#10;Detergente" /></label>
      {!item && frequent.length > 0 && <div><p className="label mb-2">Frecuentes</p><div className="flex flex-wrap gap-2">{frequent.map(({ item: p }) => <button type="button" key={productKey(p)} className="chip bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" onClick={() => { setValues({ ...newProduct(p.name), quantity: p.quantity, unit: p.unit, brand: p.brand, section: p.section }); setDuplicates([]); }}>{p.name}{p.brand ? ` · ${p.brand}` : ''}</button>)}</div></div>}
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">Cantidad <input maxLength={30} className="input mt-1" placeholder="Ej. 2" value={values.quantity} onChange={e => change('quantity', e.target.value)} /></label>
        <label className="text-sm">Unidad <input maxLength={30} className="input mt-1" placeholder="kg, litros, paquetes…" value={values.unit} onChange={e => change('unit', e.target.value)} /></label>
      </div>
      <label className="block text-sm">Rubro <select className="input mt-1" value={values.section} onChange={e => change('section', e.target.value)}>{sections.map(s => <option key={s}>{s}</option>)}</select></label>
      <details><summary className="cursor-pointer py-2 text-sm text-ink-mute dark:text-slate-400">Marca y nota (opcional)</summary><div className="space-y-3 pt-2">
        <label className="block text-sm">Marca <input maxLength={80} className="input mt-1" value={values.brand} onChange={e => change('brand', e.target.value)} /></label>
        <label className="block text-sm">Nota <input maxLength={500} className="input mt-1" value={values.note} onChange={e => change('note', e.target.value)} /></label>
      </div></details>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5 accent-emerald-600" checked={values.urgent} onChange={e => change('urgent', e.target.checked)} />Lo necesitamos pronto</label>
      {duplicates.length > 0 && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">Ya están pendientes o repetidos: {duplicates.join(', ')}.
        <button type="button" className="mt-2 block font-semibold underline" disabled={saving} onClick={() => void save(true)}>Agregar de todas formas</button></div>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button disabled={!ready || saving || !values.name.trim()} className="btn-primary flex w-full items-center justify-center gap-2 !bg-emerald-600"><ShoppingCart size={20} />{saving ? 'Guardando…' : item ? 'Guardar cambios' : 'Agregar a la lista'}</button>
    </form>
  </ShoppingDialog>;
}
