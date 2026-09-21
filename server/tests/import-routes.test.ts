/**
 * API de importación, contra las rutas reales y con sesión.
 *
 * El caso que justifica todo esto es el último: importar el mismo resumen dos
 * veces. Es lo que cualquiera hace por las dudas, y lo que arruina la base si
 * la deduplicación falla.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { makeHousehold, makeSession, sqlite, type Fixture } from './harness.js';
import { importRoutes } from '../src/routes/import.js';

const app = new Hono();
app.route('/import', importRoutes);
const texto = readFileSync(new URL('./fixtures/bbva-visa.txt', import.meta.url), 'utf8');

function cuenta(f: Fixture, nombre: string, tipo: string): string {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO accounts (id, household_id, name, type, currency) VALUES (?,?,?,?,'ARS')`)
    .run(id, f.householdId, nombre, tipo);
  return id;
}

function post(token: string, ruta: string, body: unknown) {
  return app.request(`/import${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `hormiga_session=${token}` },
    body: JSON.stringify(body),
  });
}

function nuevoHogar() {
  const f = makeHousehold();
  return {
    f,
    token: makeSession(f.userId),
    tarjeta: cuenta(f, 'Visa', 'tarjeta'),
    banco: cuenta(f, 'Banco', 'banco'),
  };
}

const cuerpo = (h: ReturnType<typeof nuevoHogar>) => ({
  bank: 'bbva', text: texto, accountId: h.tarjeta,
  paymentAccountId: h.banco, advanceAccountId: h.banco,
});

const contar = (householdId: string) =>
  (sqlite.prepare(`SELECT COUNT(*) n FROM transactions WHERE household_id = ?`).get(householdId) as { n: number }).n;

describe('POST /import/preview', () => {
  it('devuelve el plan sin escribir nada', async () => {
    const h = nuevoHogar();
    const res = await post(h.token, '/preview', cuerpo(h));
    assert.equal(res.status, 200);
    const plan = await res.json() as any;
    assert.equal(plan.statement.check.ok, true);
    assert.ok(plan.summary.nuevos > 0);
    assert.equal(contar(h.f.householdId), 0, 'previsualizar no debe crear movimientos');
  });

  it('rechaza una cuenta de otro hogar', async () => {
    const mio = nuevoHogar();
    const ajeno = nuevoHogar();
    const res = await post(mio.token, '/preview', { ...cuerpo(mio), accountId: ajeno.tarjeta });
    assert.equal(res.status, 400);
  });

  it('rechaza un texto que no es un resumen', async () => {
    const h = nuevoHogar();
    const res = await post(h.token, '/preview', { ...cuerpo(h), text: 'x'.repeat(100) });
    assert.equal(res.status, 400);
  });

  it('pide sesión', async () => {
    const res = await app.request('/import/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /import/confirm', () => {
  it('importa y deja los movimientos en la base', async () => {
    const h = nuevoHogar();
    const res = await post(h.token, '/confirm', cuerpo(h));
    assert.equal(res.status, 201);
    const out = await res.json() as any;
    assert.ok(out.importados > 0);
    assert.equal(contar(h.f.householdId), out.importados);
  });

  it('IMPORTAR DOS VECES NO DUPLICA', async () => {
    // El caso real: volvés a subir el mismo PDF por las dudas.
    const h = nuevoHogar();
    const primera = await (await post(h.token, '/confirm', cuerpo(h))).json() as any;
    const despues = contar(h.f.householdId);

    const segunda = await (await post(h.token, '/confirm', cuerpo(h))).json() as any;
    assert.equal(segunda.importados, 0, 'la segunda importación no debe crear nada');
    assert.equal(contar(h.f.householdId), despues, 'el total no debe moverse');
    assert.equal(segunda.resumen.yaImportados, primera.importados);
  });

  it('la percepción del 30% queda como transferencia, no como gasto', async () => {
    const h = nuevoHogar();
    await post(h.token, '/confirm', cuerpo(h));
    const perc = sqlite.prepare(
      `SELECT type, amount_minor FROM transactions WHERE household_id = ? AND note LIKE '%RG 5617%' AND note NOT LIKE 'CR%'`,
    ).all(h.f.householdId) as Array<{ type: string; amount_minor: number }>;
    assert.equal(perc.length, 1);
    assert.equal(perc[0].type, 'transferencia');
  });

  it('crea sola la cuenta donde esperan las percepciones', async () => {
    const h = nuevoHogar();
    await post(h.token, '/confirm', cuerpo(h));
    const cta = sqlite.prepare(`SELECT type FROM accounts WHERE household_id = ? AND name = ?`)
      .get(h.f.householdId, 'Percepciones a recuperar') as { type: string } | undefined;
    assert.ok(cta, 'la cuenta tiene que existir después de importar');
    assert.equal(cta.type, 'ahorro', 'no es un gasto: es plata del hogar en otro lado');
  });

  it('da de alta los titulares del resumen', async () => {
    const h = nuevoHogar();
    await post(h.token, '/confirm', cuerpo(h));
    const nombres = (sqlite.prepare(`SELECT name FROM card_holders WHERE account_id = ? ORDER BY name`)
      .all(h.tarjeta) as Array<{ name: string }>).map((x) => x.name);
    assert.deepEqual(nombres, ['Ana Gomez', 'Juan Perez']);
  });

  it('guarda la cuota en el movimiento', async () => {
    const h = nuevoHogar();
    await post(h.token, '/confirm', cuerpo(h));
    const tx = sqlite.prepare(
      `SELECT installment_n, installment_of FROM transactions WHERE household_id = ? AND installment_n IS NOT NULL`,
    ).all(h.f.householdId) as Array<{ installment_n: number; installment_of: number }>;
    assert.equal(tx.length, 1);
    assert.deepEqual(tx[0], { installment_n: 3, installment_of: 6 });
  });

  it('importa solo lo elegido cuando se pasa una selección', async () => {
    const h = nuevoHogar();
    const plan = await (await post(h.token, '/preview', cuerpo(h))).json() as any;
    const dos = plan.movements.filter((m: any) => m.status === 'nuevo').slice(0, 2).map((m: any) => m.fingerprint);
    const res = await (await post(h.token, '/confirm', { ...cuerpo(h), only: dos })).json() as any;
    assert.equal(res.importados, 2);
  });

  it('no importa nada si el resumen no cierra contra sus propios totales', async () => {
    // Un renglón alterado hace que la aritmética falle. Ahí no sabemos qué se
    // perdió, así que no entra nada: media importación es peor que ninguna.
    const h = nuevoHogar();
    const roto = texto.replace('25.500,50', '25.500,51');
    const res = await post(h.token, '/confirm', { ...cuerpo(h), text: roto });
    assert.equal(res.status, 422);
    assert.equal(contar(h.f.householdId), 0);
  });
});
