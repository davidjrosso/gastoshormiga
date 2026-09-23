/**
 * Edición de movimientos (PATCH /transactions/:id).
 *
 * Se prueba contra la ruta real, con sesión y todo, porque la mitad de lo que
 * importa acá vive en el handler: la validación, el aislamiento entre hogares
 * y la decisión de recongelar o no la cotización.
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { describe, it } from 'node:test';
import { addTx, clearRates, daysAgo, makeHousehold, makeSession, setRate, sqlite } from './harness.js';
import { transactionRoutes } from '../src/routes/transactions.js';

const app = new Hono();
app.route('/transactions', transactionRoutes);

describe('GET /transactions: detalle por categoría', () => {
  it('filtra por mes, gasto y categoría sin mezclar hogares; incluye Sin categoría', async () => {
    const f = makeHousehold();
    const other = makeHousehold();
    const token = makeSession(f.userId);
    const expected = addTx(f, { date: '2026-08-15', amountMinor: 12345 });
    const uncategorized = addTx(f, { date: '2026-08-15', amountMinor: 900, categoryId: null });
    addTx(f, { date: '2026-09-15', amountMinor: 100 });
    addTx(f, { date: '2026-08-15', amountMinor: 100, type: 'ingreso' });
    addTx(other, { date: '2026-08-15', amountMinor: 100, categoryId: f.categoryId });
    const getCategory = async (category: string) => {
      const res = await app.request(`/transactions?period=2026-08&type=gasto&categoryId=${category}`, {
        headers: { Cookie: `hormiga_session=${token}` },
      });
      assert.equal(res.status, 200);
      return await res.json() as Array<{ id: string }>;
    };
    assert.deepEqual((await getCategory(f.categoryId)).map((tx) => tx.id), [expected]);
    assert.deepEqual((await getCategory('')).map((tx) => tx.id), [uncategorized]);
  });

  it('pagina sin perder ni repetir gastos con la misma fecha y hora', async () => {
    const f = makeHousehold();
    const token = makeSession(f.userId);
    const ids = Array.from({ length: 5 }, () => addTx(f, { date: '2026-08-15', amountMinor: 100 }));
    sqlite.prepare('UPDATE transactions SET created_at = 1 WHERE household_id = ?').run(f.householdId);
    const found: string[] = [];
    for (const offset of [0, 2, 4, 6]) {
      const res = await app.request(`/transactions?categoryId=${f.categoryId}&limit=2&offset=${offset}`, {
        headers: { Cookie: `hormiga_session=${token}` },
      });
      assert.equal(res.status, 200);
      const page = await res.json() as Array<{ id: string }>;
      found.push(...page.map((tx) => tx.id));
    }
    assert.deepEqual(found, ids.sort().reverse());
    const bad = await app.request('/transactions?offset=-1', {
      headers: { Cookie: `hormiga_session=${token}` },
    });
    assert.equal(bad.status, 400);
  });
});

function patch(token: string, id: string, body: unknown) {
  return app.request(`/transactions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `hormiga_session=${token}` },
    body: JSON.stringify(body),
  });
}

function rateOf(id: string): number | null {
  const row = sqlite.prepare(`SELECT usd_rate_minor FROM transactions WHERE id = ?`).get(id) as
    | { usd_rate_minor: number | null }
    | undefined;
  return row?.usd_rate_minor ?? null;
}

describe('PATCH /transactions/:id', () => {
  it('corrige monto, nota y quién pagó', async () => {
    const f = makeHousehold();
    const token = makeSession(f.userId);
    const id = addTx(f, { date: daysAgo(3), amountMinor: 100_000, paidByUserId: f.userId });

    const res = await patch(token, id, {
      amount: '12.345,67',
      note: 'corregido',
      paidByUserId: f.otherUserId,
    });
    assert.equal(res.status, 200);

    const tx = await res.json() as { amountMinor: number; note: string; paidByUserId: string };
    assert.equal(tx.amountMinor, 1_234_567);
    assert.equal(tx.note, 'corregido');
    assert.equal(tx.paidByUserId, f.otherUserId);
  });

  it('recongela la cotización al día corregido', async () => {
    // El sentido de guardar la cotización es poder comparar meses sin que la
    // inflación mienta. Si se corrige la fecha, la del día viejo ya no sirve.
    const f = makeHousehold();
    const token = makeSession(f.userId);
    clearRates();
    setRate(daysAgo(40), 'blue', 100_000);
    setRate(daysAgo(3), 'blue', 145_000);

    const id = addTx(f, { date: daysAgo(3), amountMinor: 100_000, usdRateMinor: 145_000 });
    await patch(token, id, { date: daysAgo(40) });

    assert.equal(rateOf(id), 100_000);
  });

  it('conserva la cotización vieja si no hay ninguna para la fecha nueva', async () => {
    // Regresión: pisar con null una cotización que ya teníamos deja el
    // movimiento sin valuar a cambio de nada. Pasa sin internet, que es
    // justo el caso que la app dice soportar.
    const f = makeHousehold();
    const token = makeSession(f.userId);
    clearRates();

    const id = addTx(f, { date: daysAgo(3), amountMinor: 100_000, usdRateMinor: 141_500 });
    const res = await patch(token, id, { date: daysAgo(40) });

    assert.equal(res.status, 200);
    assert.equal(rateOf(id), 141_500);
  });

  it('no toca la cotización si la fecha no cambió', async () => {
    const f = makeHousehold();
    const token = makeSession(f.userId);
    clearRates();
    setRate(daysAgo(1), 'blue', 999_999);

    const fecha = daysAgo(3);
    const id = addTx(f, { date: fecha, amountMinor: 100_000, usdRateMinor: 141_500 });
    await patch(token, id, { date: fecha, note: 'solo la nota' });

    assert.equal(rateOf(id), 141_500, 'recalcular sin motivo reescribe un dato histórico correcto');
  });

  it('rechaza lo que no es un monto, en vez de explotar con un 500', async () => {
    const f = makeHousehold();
    const token = makeSession(f.userId);
    const id = addTx(f, { date: daysAgo(1), amountMinor: 100_000 });

    assert.equal((await patch(token, id, { amount: 'abc' })).status, 400);
    assert.equal((await patch(token, id, { amount: '0' })).status, 400);
    assert.equal((await patch(token, id, { date: '15/06/2026' })).status, 400);
  });

  it('no deja editar un movimiento de otro hogar', async () => {
    // El id se puede adivinar; la pertenencia al hogar es lo que corta el paso.
    const mio = makeHousehold();
    const ajeno = makeHousehold();
    const token = makeSession(mio.userId);
    const idAjeno = addTx(ajeno, { date: daysAgo(1), amountMinor: 100_000 });

    const res = await patch(token, idAjeno, { note: 'no deberías poder' });
    assert.equal(res.status, 404);

    const tx = sqlite.prepare(`SELECT note FROM transactions WHERE id = ?`).get(idAjeno) as { note: string | null };
    assert.equal(tx.note, null);
  });

  it('pide sesión', async () => {
    const f = makeHousehold();
    const id = addTx(f, { date: daysAgo(1), amountMinor: 100_000 });
    const res = await app.request(`/transactions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    });
    assert.equal(res.status, 401);
  });
});
