export interface ShoppingValues {
  name: string; quantity: string; unit: string; brand: string; note: string;
  section: string; urgent: boolean; status: 'pending' | 'bought' | 'unavailable'; batchId: string;
}
export interface ShoppingItem extends ShoppingValues { id: string; revision: number; createdAt: number }
export interface ShoppingSnapshot { items: ShoppingItem[]; revision: number }
export type ShoppingOperation = { id: string; itemId: string } & (
  { kind: 'add'; values: ShoppingValues } |
  { kind: 'patch'; values: Partial<ShoppingValues>; base: Partial<ShoppingValues> }
);
export interface QueuedOperation { operation: ShoppingOperation; createdAt: number; error?: string }
export interface ShoppingCache { snapshot: ShoppingSnapshot; queue: QueuedOperation[]; syncedAt: number | null }
export const emptyCache = (): ShoppingCache => ({ snapshot: { items: [], revision: 0 }, queue: [], syncedAt: null });
export const sections = ['Sin rubro', 'Almacén', 'Lácteos', 'Frutas y verduras', 'Carnicería', 'Panadería', 'Bebidas', 'Limpieza', 'Higiene', 'Mascotas', 'Otros'];
export const newProduct = (name: string): ShoppingValues => ({ name, quantity: '', unit: '', brand: '', note: '', section: 'Sin rubro', urgent: false, status: 'pending', batchId: '' });
export function visibleItems(cache: ShoppingCache): ShoppingItem[] {
  const rows = new Map(cache.snapshot.items.map(item => [item.id, { ...item }]));
  for (const { operation: op, createdAt } of cache.queue) {
    if (op.kind === 'add') rows.set(op.itemId, { ...op.values, id: op.itemId, revision: 0, createdAt });
    else if (rows.has(op.itemId)) rows.set(op.itemId, { ...rows.get(op.itemId)!, ...op.values });
  }
  return [...rows.values()];
}
export function patchOperation(item: ShoppingItem, values: Partial<ShoppingValues>): ShoppingOperation {
  const base: Partial<ShoppingValues> = { batchId: item.batchId };
  for (const key of Object.keys(values) as Array<keyof ShoppingValues>) Object.assign(base, { [key]: item[key] });
  if (values.batchId) base.status = item.status;
  return { id: crypto.randomUUID(), itemId: item.id, kind: 'patch', base, values };
}
export function acceptSnapshot(cache: ShoppingCache, snapshot: ShoppingSnapshot) {
  if (snapshot.revision >= cache.snapshot.revision) cache.snapshot = snapshot;
}
export function productKey(item: Pick<ShoppingValues, 'name' | 'brand'>) {
  return `${item.name.trim()}|${item.brand.trim()}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}
