import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../App';
import { ApiError, api, type Account, type Category } from '../lib/api';
import { money, todayISO } from '../lib/format';

type Kind = 'gasto' | 'ingreso' | 'transferencia';

/**
 * Carga rápida.
 *
 * Todo el diseño de esta pantalla responde a una sola idea: el enemigo no es
 * la complejidad, es la fricción. Una app de gastos no muere porque le falten
 * funciones, muere el día que anotar un café cuesta más que el café.
 *
 * Por eso: monto enfocado al abrir, categorías como botones (no un desplegable),
 * fecha de hoy por defecto y escondida, y guardar disponible apenas hay monto.
 */
export default function QuickAdd({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<Kind>('gasto');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [merchantName, setMerchantName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const { me } = useAuth();
  // Quién puso la plata. Por defecto vos, que es el caso normal, pero se puede
  // cambiar: anotar a la noche lo que pagó el otro a la mañana es habitual, y
  // si eso queda registrado a tu nombre los totales por persona mienten.
  const [paidByUserId, setPaidByUserId] = useState(me?.user.id ?? '');
  const miembros = me?.members ?? [];

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [merchants, setMerchants] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.categories(), api.accounts(), api.merchants()])
      .then(([cats, accs, mers]) => {
        setCategories(cats);
        setAccounts(accs);
        setMerchants(mers.map((m) => m.name));
        if (accs.length > 0) {
          setAccountId(accs[0].accountId);
          const usd = accs.find((a) => a.currency === 'USD');
          if (usd) setToAccountId(usd.accountId);
        }
      })
      .catch(() => setError('No se pudieron cargar las categorías'));
  }, []);

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const visibleCategories = useMemo(
    () => categories.filter((c) => c.kind === (kind === 'ingreso' ? 'ingreso' : 'gasto')),
    [categories, kind],
  );

  const fromAccount = accounts.find((a) => a.accountId === accountId);
  const toAccount = accounts.find((a) => a.accountId === toAccountId);
  const isFx = kind === 'transferencia' && fromAccount && toAccount
    && fromAccount.currency !== toAccount.currency;

  // Cotización implícita de la operación. Mostrarla en vivo evita el error
  // más común al comprar dólares: equivocarse de campo y cargar los pesos
  // donde van los dólares.
  const impliedRate = useMemo(() => {
    if (!isFx) return null;
    const ars = Number(amount.replace(/\./g, '').replace(',', '.'));
    const usd = Number(amountTo.replace(/\./g, '').replace(',', '.'));
    if (!ars || !usd) return null;
    return Math.round((ars / usd) * 100);
  }, [isFx, amount, amountTo]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await api.createTransaction({
        type: kind,
        amount,
        currency: fromAccount?.currency ?? 'ARS',
        date,
        accountId,
        categoryId: kind === 'transferencia' ? null : categoryId,
        merchantName: merchantName || null,
        note: note || null,
        paidByUserId: paidByUserId || null,
        ...(kind === 'transferencia'
          ? {
              toAccountId,
              amountTo: amountTo || amount,
              currencyTo: toAccount?.currency ?? 'ARS',
            }
          : {}),
      });
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

        <div className="mb-4 flex gap-1 rounded-xl bg-slate-200 p-1 dark:bg-slate-800">
          {(['gasto', 'ingreso', 'transferencia'] as Kind[]).map((k) => (
            <button
              key={k}
              onClick={() => { setKind(k); setCategoryId(null); }}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold capitalize transition ${
                kind === k
                  ? 'bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-ink-mute dark:text-slate-400'
              }`}
            >
              {k}
            </button>
          ))}
        </div>

        <div className="card">
          <label className="label" htmlFor="amount">
            {isFx ? `Cuántos ${fromAccount?.currency} salen` : 'Monto'}
          </label>
          <input
            ref={amountRef}
            id="amount"
            className="mt-1 w-full bg-transparent text-4xl font-bold tabular outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />

          {isFx && (
            <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
              <label className="label" htmlFor="amountTo">
                Cuántos {toAccount?.currency} entran
              </label>
              <input
                id="amountTo"
                className="mt-1 w-full bg-transparent text-2xl font-bold tabular outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700"
                inputMode="decimal"
                placeholder="0"
                value={amountTo}
                onChange={(e) => setAmountTo(e.target.value)}
              />
              {impliedRate && (
                <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
                  Te salió a <strong className="tabular">{money(impliedRate)}</strong> por{' '}
                  {toAccount?.currency}
                </p>
              )}
            </div>
          )}
        </div>

        {kind !== 'transferencia' && (
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

        {kind !== 'transferencia' && miembros.length > 1 && (
          <div className="card mt-3">
            <p className="label mb-2">{kind === 'ingreso' ? 'Quién lo cobró' : 'Quién pagó'}</p>
            <div className="flex flex-wrap gap-2">
              {miembros.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setPaidByUserId(m.id)}
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

        {kind === 'transferencia' ? (
          <div className="card mt-3 space-y-3">
            <div>
              <label className="label" htmlFor="from">Desde</label>
              <select id="from" className="input mt-1" value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="to">Hacia</label>
              <select id="to" className="input mt-1" value={toAccountId}
                      onChange={(e) => setToAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="card mt-3">
            <label className="label" htmlFor="merchant">Dónde</label>
            <input
              id="merchant" className="input mt-1" list="merchant-list"
              placeholder="Café de la esquina, Coto, Netflix…"
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
            />
            <datalist id="merchant-list">
              {merchants.map((m) => <option key={m} value={m} />)}
            </datalist>
            <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
              Poner el comercio es lo que después permite detectar el gasto hormiga.
              Sin esto solo vas a ver "Café y kiosco: mucha plata".
            </p>
          </div>
        )}

        {showDetails ? (
          <div className="card mt-3 space-y-3">
            <div>
              <label className="label" htmlFor="date">Fecha</label>
              <input id="date" type="date" className="input mt-1" value={date}
                     onChange={(e) => setDate(e.target.value)} />
            </div>
            {kind !== 'transferencia' && (
              <div>
                <label className="label" htmlFor="account">Cuenta</label>
                <select id="account" className="input mt-1" value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="label" htmlFor="note">Nota</label>
              <input id="note" className="input mt-1" value={note}
                     onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        ) : (
          <button
            className="mt-3 w-full py-2 text-sm text-ink-mute underline dark:text-slate-400"
            onClick={() => setShowDetails(true)}
          >
            Cambiar fecha, cuenta o agregar nota
          </button>
        )}

        {error && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="sticky bottom-0 mt-4 flex gap-2 bg-slate-100 py-3 dark:bg-slate-950">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancelar</button>
          <button className="btn-primary flex-[2]" onClick={save} disabled={busy || !amount}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
