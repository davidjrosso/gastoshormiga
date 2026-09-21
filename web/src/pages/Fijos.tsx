import { useEffect, useState } from 'react';
import { useAuth, useRefresh } from '../App';
import { api, type Account, type Category, type RecurringRule } from '../lib/api';
import { money, moneyShort } from '../lib/format';

/**
 * Gastos fijos. Una regla acá genera automáticamente la transacción del mes,
 * así que el alquiler no depende de que alguien se acuerde de anotarlo.
 */
export default function Fijos() {
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [adding, setAdding] = useState(false);
  const { token, bump } = useRefresh();
  const { me } = useAuth();
  const miembros = me?.members ?? [];

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [paidByUserId, setPaidByUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.recurring(), api.accounts(), api.categories()])
      .then(([r, a, c]) => {
        setRules(r);
        setAccounts(a);
        setCategories(c.filter((x) => x.kind === 'gasto'));
        if (a.length > 0 && !accountId) setAccountId(a[0].accountId);
      })
      .catch(console.error);
    // accountId queda fuera a propósito: solo queremos el valor inicial,
    // no pisar la cuenta que el usuario haya elegido en el formulario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function create() {
    setError(null);
    try {
      await api.createRecurring({
        description,
        amount,
        accountId,
        categoryId: categoryId || null,
        dayOfMonth,
        paidByUserId,
      });
      setDescription(''); setAmount(''); setCategoryId(''); setDayOfMonth(1);
      setPaidByUserId(null);
      setAdding(false);
      bump();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear');
    }
  }

  async function toggle(rule: RecurringRule) {
    await api.updateRecurring(rule.id, { active: !rule.active });
    bump();
  }

  /** Quién pone la plata para este fijo. Se puede cambiar sobre la regla ya
   *  creada: los fijos que venían de antes nacieron sin este dato y sería
   *  absurdo obligar a borrarlos y recargarlos solo para asignarlo. */
  async function setPaidBy(rule: RecurringRule, userId: string | null) {
    await api.updateRecurring(rule.id, { paidByUserId: rule.paidByUserId === userId ? null : userId });
    bump();
  }

  async function remove(id: string) {
    if (!confirm('¿Borrar este gasto fijo? Los movimientos ya generados quedan.')) return;
    await api.deleteRecurring(id);
    bump();
  }

  const monthlyTotal = rules
    .filter((r) => r.active && r.currency === 'ARS')
    .reduce((s, r) => s + r.amountMinor, 0);

  return (
    <div className="space-y-3 p-3">
      <header className="px-1 pt-2">
        <h1 className="text-lg font-bold">Gastos fijos</h1>
        <p className="text-sm text-ink-mute dark:text-slate-400">
          Se cargan solos cada mes. No hace falta acordarse.
        </p>
      </header>

      {monthlyTotal > 0 && (
        <div className="card">
          <p className="label">Comprometido por mes</p>
          <p className="tabular mt-1 text-3xl font-bold">{money(monthlyTotal)}</p>
          <p className="mt-0.5 text-sm text-ink-mute dark:text-slate-400">
            {moneyShort(monthlyTotal * 12)} al año
          </p>
        </div>
      )}

      {rules.map((r) => {
        const cat = categories.find((c) => c.id === r.categoryId);
        return (
          <div key={r.id} className={`card ${!r.active ? 'opacity-50' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">{r.description}</p>
                <p className="text-xs text-ink-mute dark:text-slate-400">
                  Día {r.dayOfMonth} de cada mes
                  {cat && <> · {cat.icon} {cat.name}</>}
                </p>
              </div>
              <span className="tabular shrink-0 font-semibold">
                {money(r.amountMinor, r.currency as 'ARS' | 'USD', false)}
              </span>
            </div>
            {miembros.length > 1 && (
              <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                <p className="label mb-2">Quién lo paga</p>
                <div className="flex flex-wrap gap-2">
                  {miembros.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setPaidBy(r, m.id)}
                      className={`chip ring-1 ${
                        r.paidByUserId === m.id
                          ? 'bg-ink text-white ring-transparent dark:bg-white dark:text-ink'
                          : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
                      }`}
                    >
                      {m.displayName}
                      {m.id === me?.user.id && <span className="ml-1 opacity-60">(vos)</span>}
                    </button>
                  ))}
                </div>
                {r.paidByUserId === null && (
                  <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
                    Sin asignar: no suma a nadie en "Quién pagó qué".
                  </p>
                )}
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <button onClick={() => toggle(r)} className="chip bg-slate-100 text-ink dark:bg-slate-800 dark:text-slate-200">
                {r.active ? 'Pausar' : 'Reactivar'}
              </button>
              <button onClick={() => remove(r.id)} className="chip bg-slate-100 text-red-600 dark:bg-slate-800 dark:text-red-400">
                Borrar
              </button>
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="card space-y-3">
          <div>
            <label className="label" htmlFor="desc">Qué es</label>
            <input id="desc" className="input mt-1" value={description}
                   onChange={(e) => setDescription(e.target.value)}
                   placeholder="Alquiler, Netflix, prepaga…" />
          </div>
          <div>
            <label className="label" htmlFor="amt">Cuánto</label>
            <input id="amt" className="input mt-1 tabular" inputMode="decimal" value={amount}
                   onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label className="label" htmlFor="day">Qué día del mes</label>
            <input id="day" type="number" min={1} max={31} className="input mt-1"
                   value={dayOfMonth}
                   onChange={(e) => setDayOfMonth(Number(e.target.value))} />
          </div>
          <div>
            <label className="label" htmlFor="cat">Categoría</label>
            <select id="cat" className="input mt-1" value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="acc">De qué cuenta sale</label>
            <select id="acc" className="input mt-1" value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>{a.name} ({a.currency})</option>
              ))}
            </select>
          </div>

          {miembros.length > 1 && (
            <div>
              <p className="label mb-2">Quién lo paga</p>
              <div className="flex flex-wrap gap-2">
                {miembros.map((m) => (
                  <button
                    key={m.id}
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
              <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
                Si sale de la cuenta conjunta, dejalo sin elegir.
              </p>
            </div>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setAdding(false)}>Cancelar</button>
            <button className="btn-primary flex-1" onClick={create}
                    disabled={!description || !amount}>Guardar</button>
          </div>
        </div>
      ) : (
        <button className="btn-ghost w-full" onClick={() => setAdding(true)}>
          + Agregar gasto fijo
        </button>
      )}
    </div>
  );
}
