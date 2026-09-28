import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { sqlite } from '../db/index.js';

const fields = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.string().trim().max(30),
  unit: z.string().trim().max(30),
  brand: z.string().trim().max(80),
  note: z.string().trim().max(500),
  section: z.string().trim().min(1).max(60),
  urgent: z.boolean(),
  status: z.enum(['pending', 'bought', 'unavailable']),
  batchId: z.string().max(80),
}).strict();
const operation = z.discriminatedUnion('kind', [
  z.object({ id: z.string().uuid(), itemId: z.string().uuid(), kind: z.literal('add'), values: fields }).strict(),
  z.object({ id: z.string().uuid(), itemId: z.string().uuid(), kind: z.literal('patch'), values: fields.partial(), base: fields.partial() }).strict(),
]);
type Values = z.infer<typeof fields>;
type Row = { id: string; data_json: string; revision: number; created_at: number };
const unpack = (row: Row) => ({ ...JSON.parse(row.data_json) as Values, id: row.id, revision: row.revision, createdAt: row.created_at });
function snapshot(householdId: string) {
  return sqlite.transaction(() => ({
    revision: (sqlite.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM shopping_operations WHERE household_id=?').get(householdId) as { n: number }).n,
    items: (sqlite.prepare('SELECT * FROM shopping_items WHERE household_id=? ORDER BY created_at, id').all(householdId) as Row[]).map(unpack),
  }))();
}

export const shoppingRoutes = new Hono<AppEnv>();
shoppingRoutes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
shoppingRoutes.use('*', requireAuth);
shoppingRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  if (c.req.header('X-Hormiga-Household') !== user.householdId || c.req.header('X-Hormiga-User') !== user.id) {
    return c.json({ error: 'La sesión cambió. Volvé a ingresar.' }, 403);
  }
  await next();
});
shoppingRoutes.get('/', c => c.json(snapshot(c.get('user').householdId)));
shoppingRoutes.post('/operations', async c => {
  const parsed = operation.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Revisá los datos del producto' }, 400);
  const op = parsed.data;
  const household = c.get('user').householdId;
  const result = sqlite.transaction(() => {
    const payload = JSON.stringify(op);
    const receipt = sqlite.prepare('SELECT payload FROM shopping_operations WHERE household_id=? AND operation_id=?').get(household, op.id) as { payload: string } | undefined;
    if (receipt) return receipt.payload === payload ? null : { error: 'La operación ya existe con otros datos', code: 409 as const };
    const row = sqlite.prepare('SELECT * FROM shopping_items WHERE household_id=? AND id=?').get(household, op.itemId) as Row | undefined;
    let next: Values;
    if (op.kind === 'add') {
      if (row) return { error: 'Este producto ya existe', code: 409 as const };
      if (op.values.status !== 'pending' || op.values.batchId) return { error: 'Un producto nuevo debe estar pendiente', code: 400 as const };
      next = op.values;
    } else {
      if (!row) return { error: 'Producto no disponible en este hogar', code: 404 as const };
      const current = JSON.parse(row.data_json) as Values;
      const keys = Object.keys(op.values) as Array<keyof Values>;
      if (!keys.length || !('batchId' in op.base) || keys.some(k => !(k in op.base))) {
        return { error: 'Falta el estado original del cambio', code: 400 as const };
      }
      // Field-level comparison merges independent changes and surfaces collisions.
      const conflicts = (Object.keys(op.base) as Array<keyof Values>).filter(k => current[k] !== op.base[k] && current[k] !== op.values[k]);
      if (conflicts.length) return { error: 'Otra persona cambió este producto. Revisá ambas versiones.', code: 409 as const };
      next = { ...current, ...op.values };
      if (next.batchId && next.status !== 'bought') return { error: 'Solo se guardan en el historial productos comprados', code: 400 as const };
      if (op.values.batchId && op.base.status !== 'bought') return { error: 'Revisá el estado antes de guardar en el historial', code: 400 as const };
    }
    const receiptResult = sqlite.prepare('INSERT INTO shopping_operations(household_id,operation_id,payload) VALUES(?,?,?)').run(household, op.id, payload);
    const revision = Number(receiptResult.lastInsertRowid);
    sqlite.prepare(`INSERT INTO shopping_items(household_id,id,data_json,revision,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(household_id,id) DO UPDATE SET data_json=excluded.data_json, revision=excluded.revision`)
      .run(household, op.itemId, JSON.stringify(next), revision, Date.now());
    return null;
  }).immediate();
  if (result) return c.json({ error: result.error, snapshot: snapshot(household) }, result.code);
  return c.json(snapshot(household));
});
