import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth.js';
import { parseBbvaVisa } from '../import/bbva-visa.js';
import { extractPdf } from '../statements/extract.js';
import { fromParsed } from '../statements/model.js';
import {
  addSettlement,
  createDraft,
  getStatement,
  LedgerError,
  listStatements,
  removeSettlement,
  saveStatement,
  configureMovements,
} from '../statements/repository.js';
import { MovementError, movementSettings } from '../statements/movements.js';
import { documentSchema, settlementSchema } from '../statements/validation.js';

export const statementRoutes = new Hono<AppEnv>();
statementRoutes.use('*', requireAuth);
statementRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
statementRoutes.use(
  '*',
  bodyLimit({
    maxSize: 13 * 1024 * 1024,
    onError: (c) => c.json({ error: 'El archivo supera el limite de 12 MB.' }, 413),
  }),
);
statementRoutes.onError((e, c) => {
  if (e instanceof MovementError) return c.json({ error: e.message }, 409);
  if (e instanceof LedgerError) return c.json({ error: e.message }, e.status);
  if (e instanceof z.ZodError)
    return c.json(
      { error: `Datos invalidos: ${e.issues[0].path.join('.')} ${e.issues[0].message}` },
      400,
    );
  return c.json(
    { error: 'No se pudo completar la operacion. No se guardaron cambios parciales.' },
    500,
  );
});
statementRoutes.get('/', (c) => c.json(listStatements(c.get('user').householdId)));
statementRoutes.get('/movement-settings', (c) => c.json(movementSettings(c.get('user').householdId)));
statementRoutes.post('/:id/movements', async (c) => {
  const mappings = z.array(z.object({ holder: z.string().min(1).max(200), userId: z.string().min(1).nullable() })).max(100).parse(await c.req.json());
  return c.json(configureMovements(c.get('user').householdId, c.req.param('id'), mappings, c.get('user').id));
});
statementRoutes.get('/:id', (c) =>
  c.json(getStatement(c.get('user').householdId, c.req.param('id'))),
);
statementRoutes.post('/analyze', async (c) => {
  const file = (await c.req.parseBody()).file;
  if (!(file instanceof File)) return c.json({ error: 'Selecciona un PDF.' }, 400);
  const data = Buffer.from(await file.arrayBuffer());
  let extracted;
  try {
    extracted = await extractPdf(data);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
  const parsed = parseBbvaVisa(extracted.text);
  const warnings = extracted.usedOcr
    ? ['Lectura OCR: verifica fechas, nombres, monedas e importes contra el PDF.']
    : [];
  if (!parsed.check.ok)
    warnings.push('La lectura no concilia. Corrige el texto o los movimientos antes de confirmar.');
  if (!/BBVA/i.test(extracted.text))
    return c.json({ error: 'No se reconoce un resumen BBVA.' }, 422);
  const result = createDraft(
    c.get('user').householdId,
    createHash('sha256').update(data).digest('hex'),
    file.name.slice(0, 160),
    fromParsed(parsed, warnings),
  );
  return c.json({ ...result, text: extracted.text });
});
statementRoutes.post('/parse', async (c) => {
  const { text } = z.object({ text: z.string().min(30).max(500_000) }).parse(await c.req.json());
  if (!/BBVA/i.test(text)) return c.json({ error: 'No se reconoce un resumen BBVA.' }, 422);
  const parsed = parseBbvaVisa(text);
  return c.json(
    fromParsed(parsed, parsed.check.ok ? [] : ['La lectura no concilia. Revisa los importes.']),
  );
});
statementRoutes.put('/:id', async (c) => {
  const body = z
    .object({
      revision: z.number().int().positive(),
      document: documentSchema,
      confirm: z.boolean(),
    })
    .parse(await c.req.json());
  return c.json(
    saveStatement(
      c.get('user').householdId,
      c.req.param('id'),
      body.revision,
      body.document,
      body.confirm,
      c.get('user').id,
    ),
  );
});
statementRoutes.post('/:id/settlements', async (c) =>
  c.json(
    addSettlement(
      c.get('user').householdId,
      c.req.param('id'),
      settlementSchema.parse(await c.req.json()),
    ),
  ),
);
statementRoutes.delete('/:id/settlements/:settlementId', (c) =>
  c.json(
    removeSettlement(c.get('user').householdId, c.req.param('id'), c.req.param('settlementId')),
  ),
);
