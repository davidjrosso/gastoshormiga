import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { sqlite } from '../db/index.js';
import { assignEvent, EventError } from '../events.js';

export const eventRoutes = new Hono<AppEnv>();
eventRoutes.use('*', requireAuth);
eventRoutes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
const fields = z.object({ name: z.string().trim().min(1).max(100), extraordinary: z.boolean(), archived: z.boolean() });

eventRoutes.get('/', c => {
  const rows = sqlite.prepare(`SELECT e.id,e.name,e.extraordinary,e.archived,
    COUNT(t.id) AS expenseCount,
    COALESCE(SUM(CASE WHEN t.currency='ARS' THEN t.amount_minor ELSE 0 END),0) AS arsMinor,
    COALESCE(SUM(CASE WHEN t.currency='USD' THEN t.amount_minor ELSE 0 END),0) AS usdCents
    FROM events e LEFT JOIN event_transactions et ON et.event_id=e.id
    LEFT JOIN transactions t ON t.id=et.transaction_id AND t.household_id=e.household_id AND t.type='gasto'
    WHERE e.household_id=? GROUP BY e.id ORDER BY e.archived,e.created_at DESC,e.id`)
    .all(c.get('user').householdId) as { extraordinary: number; archived: number }[];
  return c.json(rows.map(r => ({ ...r, extraordinary: !!r.extraordinary, archived: !!r.archived })));
});
eventRoutes.post('/', async c => {
  const parsed = fields.omit({ archived: true }).extend({ extraordinary: z.boolean().default(true) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Ingresá un nombre de hasta 100 caracteres y un tipo de evento válido.' }, 400);
  const id = randomUUID();
  sqlite.prepare('INSERT INTO events(id,household_id,name,extraordinary,created_at) VALUES (?,?,?,?,?)')
    .run(id, c.get('user').householdId, parsed.data.name, Number(parsed.data.extraordinary), Date.now());
  return c.json({ id, ...parsed.data, archived: false, expenseCount: 0, arsMinor: 0, usdCents: 0 }, 201);
});
eventRoutes.post('/assign', async c => {
  const parsed = z.object({ transactionIds: z.array(z.string().min(1)).min(1).max(500), eventId: z.string().min(1).nullable(), allInstallments: z.boolean().default(false) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Revisá el evento y los movimientos seleccionados (máximo 500).' }, 400);
  try { return c.json(assignEvent(c.get('user').householdId, parsed.data.transactionIds, parsed.data.eventId, parsed.data.allInstallments)); }
  catch (error) { if (error instanceof EventError) return c.json({ error: error.message }, 400); throw error; }
});
eventRoutes.patch('/:id', async c => {
  const parsed = fields.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Revisá el nombre y las opciones del evento.' }, 400);
  const household = c.get('user').householdId;
  const id = c.req.param('id');
  const old = sqlite.prepare('SELECT name,extraordinary,archived FROM events WHERE id=? AND household_id=?').get(id, household) as
    { name: string; extraordinary: number; archived: number } | undefined;
  if (!old) return c.json({ error: 'Evento no encontrado.' }, 404);
  const d = parsed.data;
  sqlite.prepare('UPDATE events SET name=?,extraordinary=?,archived=? WHERE id=? AND household_id=?')
    .run(d.name ?? old.name, d.extraordinary === undefined ? old.extraordinary : Number(d.extraordinary), d.archived === undefined ? old.archived : Number(d.archived), id, household);
  return c.json({ ok: true });
});
