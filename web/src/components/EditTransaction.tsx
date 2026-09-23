import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../App';
import { ApiError, api, type Category, type Transaction } from '../lib/api';
import { amountForInput } from '../lib/format';
import EventPicker from './EventPicker';

/**
 * Edición de un movimiento ya cargado.
 *
 * Existe porque hasta ahora el único arreglo posible era borrar y volver a
 * cargar, y eso tiene un costo que no se ve: al borrar se pierde la fecha de
 * carga y la cotización congelada del día original, que es justo lo que
 * sostiene la comparación entre meses.
 *
 * Deliberadamente NO deja cambiar el tipo ni la cuenta. Pasar un gasto a
 * transferencia obliga a pedir cuenta destino, monto recibido y moneda, y una
 * transferencia a medio editar rompe los saldos sin avisar. Para eso está
 * borrar y cargar de nuevo, que al menos es explícito.
 */
export default function EditTransaction({
  tx,
  onClose,
  onSaved,
}: {
  tx: Transaction;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { me } = useAuth();
  const miembros = me?.members ?? [];
  const esTransferencia = tx.type === 'transferencia';

  const [amount, setAmount] = useState(amountForInput(tx.amountMinor));
  const [date, setDate] = useState(tx.date);
  const [categoryId, setCategoryId] = useState<string | null>(tx.categoryId);
  const [eventId, setEventId] = useState<string | null>(tx.eventId ?? null);
  const [eventAllInstallments, setEventAllInstallments] = useState(false);
  const [merchantName, setMerchantName] = useState(tx.merchantName ?? '');
  const [note, setNote] = useState(tx.note ?? '');
  const [paidByUserId, setPaidByUserId] = useState<string | null>(tx.paidByUserId);

  const [categories, setCategories] = useState<Category[]>([]);
  const [merchants, setMerchants] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (esTransferencia) return;
    Promise.all([api.categories(), api.merchants()])
      .then(([cats, mers]) => {
        setCategories(cats);
        setMerchants(mers.map((m) => m.name));
      })
      .catch(() => setError('No se pudieron cargar las categorías'));
  }, [esTransferencia]);

  const visibleCategories = useMemo(
    () => categories.filter((c) => c.kind === (tx.type === 'ingreso' ? 'ingreso' : 'gasto')),
    [categories, tx.type],
  );

  // Mandamos solo lo que cambió. Si el usuario no tocó la fecha, el server no
  // recongela la cotización: recalcularla sin motivo sería reescribir un dato
  // histórico correcto.
  const cambios = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (eventId !== (tx.eventId ?? null) || eventAllInstallments) {
      out.eventId = eventId; out.eventAllInstallments = eventAllInstallments;
    }
    if (amount !== amountForInput(tx.amountMinor)) out.amount = amount;
    if (date !== tx.date) out.date = date;
    if (!esTransferencia) {
      if (categoryId !== tx.categoryId) out.categoryId = categoryId;
      if (merchantName !== (tx.merchantName ?? '')) out.merchantName = merchantName || null;
      if (paidByUserId !== tx.paidByUserId) out.paidByUserId = paidByUserId;
    }
    if (note !== (tx.note ?? '')) out.note = note || null;
    return out;
  }, [amount, date, categoryId, merchantName, note, paidByUserId, tx, esTransferencia, eventId, eventAllInstallments]);

  const hayCambios = Object.keys(cambios).length > 0;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await api.updateTransaction(tx.id, cambios);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-slate-100 p-4 dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />

        <header className="mb-3 px-1">
          <h2 className="text-lg font-bold">Editar movimiento</h2>
          <p className="text-sm text-ink-mute dark:text-slate-400">
            {esTransferencia
              ? 'Transferencia'
              : `${tx.type === 'ingreso' ? 'Ingreso' : 'Gasto'} · ${tx.accountName ?? ''}`}
          </p>
        </header>
        {tx.statementId && <p className="mb-3 text-sm text-ink-mute">Vinculado a resumen de tarjeta</p>}

        <div className="card">
          <label className="label" htmlFor="edit-amount">Monto</label>
          <input
            id="edit-amount"
            className="mt-1 w-full bg-transparent text-4xl font-bold tabular outline-none placeholder:text-slate-300 disabled:opacity-50 dark:placeholder:text-slate-700"
            inputMode="decimal"
            value={amount}
            disabled={esTransferencia || !!tx.statementId}
            onChange={(e) => setAmount(e.target.value)}
          />
          {esTransferencia && (
            <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
              El monto de una transferencia no se edita acá: origen y destino tienen que
              cambiar juntos o la cotización a la que compraste queda mal. Borrala y cargala
              de nuevo.
            </p>
          )}
        </div>

        {!esTransferencia && (
          <div className="mt-3">
            <p className="label mb-2">Categoría</p>
            <div className="flex flex-wrap gap-2">
              {visibleCategories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
                  className={`chip ring-1 ${
                    categoryId === c.id
                      ? 'text-white ring-transparent'
                      : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
                  }`}
                  style={categoryId === c.id ? { backgroundColor: c.color } : undefined}
                >
                  <span className="mr-1">{c.icon}</span>
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {!esTransferencia && (
          <div className="card mt-3">
            <label className="label" htmlFor="edit-merchant">Dónde</label>
            <input
              id="edit-merchant" className="input mt-1" list="edit-merchant-list"
              placeholder="Café de la esquina, Coto, Netflix…"
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
            />
            <datalist id="edit-merchant-list">
              {merchants.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
        )}

        {!esTransferencia && miembros.length > 1 && (
          <div className="card mt-3">
            <p className="label mb-2">{tx.type === 'ingreso' ? 'Quién lo cobró' : 'Quién pagó'}</p>
            <div className="flex flex-wrap gap-2">
              {miembros.map((m) => (
                <button
                  key={m.id}
                  disabled={!!tx.statementId}
                  onClick={() => setPaidByUserId(paidByUserId === m.id ? null : m.id)}
                  className={`chip ring-1 ${
                    paidByUserId === m.id
                      ? 'bg-ink text-white ring-transparent dark:bg-white dark:text-ink'
                      : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
                  }`}
                >
                  {m.displayName}
                  {m.id === me?.user.id && <span className="ml-1 opacity-60">(vos)</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {tx.type === 'gasto' && <div className="card mt-3 space-y-3">
          <EventPicker value={eventId} onChange={setEventId} />
          {tx.canApplyEventToPurchase && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={eventAllInstallments} onChange={e => setEventAllInstallments(e.target.checked)} />Aplicar también a las otras cuotas de esta compra, incluidas las de próximos resúmenes.</label>}
          {tx.statementId && !tx.canApplyEventToPurchase && <p className="text-xs text-ink-mute">Se aplica a este movimiento. Para otras cuotas sin identificación exacta, usá la selección de gastos.</p>}
          <p className="text-xs text-ink-mute">El evento no cambia el importe ni la categoría. Sin marcar otras cuotas, solo se modifica este movimiento.</p>
        </div>}

        <div className="card mt-3 space-y-3">
          <div>
            <label className="label" htmlFor="edit-date">Fecha</label>
            <input id="edit-date" type="date" className="input mt-1" value={date}
                   disabled={!!tx.statementId}
                   onChange={(e) => setDate(e.target.value)} />
            {date !== tx.date && (
              <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
                Al cambiar la fecha se vuelve a guardar la cotización de ese día.
              </p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="edit-note">Nota</label>
            <input id="edit-note" className="input mt-1" value={note}
                   onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="sticky bottom-0 mt-4 flex gap-2 bg-slate-100 py-3 dark:bg-slate-950">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancelar</button>
          <button className="btn-primary flex-[2]" onClick={save} disabled={busy || !hayCambios || !amount}>
            {busy ? 'Guardando…' : hayCambios ? 'Guardar cambios' : 'Sin cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
