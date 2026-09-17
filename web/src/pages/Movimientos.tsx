import { useEffect, useState } from 'react';
import { useAuth, useRefresh } from '../App';
import { api, type Transaction } from '../lib/api';
import { currentPeriod, dayLabel, money, periodLabel, shiftPeriod } from '../lib/format';

export default function Movimientos() {
  const [period, setPeriod] = useState(currentPeriod());
  const [items, setItems] = useState<Transaction[]>([]);
  const [filter, setFilter] = useState<'todos' | 'gasto' | 'ingreso' | 'transferencia'>('todos');
  const [paidBy, setPaidBy] = useState<string>('');
  const { token, bump } = useRefresh();
  const { me } = useAuth();

  const miembros = me?.members ?? [];
  /** Resuelve el nombre sin pedirle nada más al servidor: los integrantes del
   *  hogar ya vienen en /auth/me, y son dos. */
  const nombreDe = (userId: string | null) =>
    miembros.find((m) => m.id === userId)?.displayName ?? null;

  useEffect(() => {
    api.transactions({
      period,
      type: filter === 'todos' ? undefined : filter,
      paidBy: paidBy || undefined,
      limit: 500,
    })
      .then(setItems)
      .catch(console.error);
  }, [period, filter, paidBy, token]);

  async function remove(id: string) {
    if (!confirm('¿Borrar este movimiento?')) return;
    await api.deleteTransaction(id);
    bump();
  }

  // Agrupamos por día para que la lista se lea como un extracto y no como
  // una pila indiferenciada de renglones.
  const byDay = items.reduce<Record<string, Transaction[]>>((acc, t) => {
    (acc[t.date] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-3 p-3">
      <header className="flex items-center justify-between px-1 pt-2">
        <button className="rounded-lg px-3 py-1 text-xl text-ink-mute"
                onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label="Mes anterior">‹</button>
        <h1 className="text-lg font-bold capitalize">{periodLabel(period)}</h1>
        <button className="rounded-lg px-3 py-1 text-xl text-ink-mute disabled:opacity-25"
                onClick={() => setPeriod(shiftPeriod(period, -1))}
                disabled={period === currentPeriod()} aria-label="Mes siguiente">›</button>
      </header>

      <div className="flex gap-2 overflow-x-auto px-1 pb-1">
        {(['todos', 'gasto', 'ingreso', 'transferencia'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`chip shrink-0 capitalize ring-1 ${
              filter === f
                ? 'bg-ant text-white ring-transparent'
                : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {miembros.length > 1 && (
        <div className="flex gap-2 overflow-x-auto px-1 pb-1">
          <button
            onClick={() => setPaidBy('')}
            className={`chip shrink-0 ring-1 ${
              paidBy === ''
                ? 'bg-ink text-white ring-transparent dark:bg-white dark:text-ink'
                : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
            }`}
          >
            Los dos
          </button>
          {miembros.map((m) => (
            <button
              key={m.id}
              onClick={() => setPaidBy(m.id)}
              className={`chip shrink-0 ring-1 ${
                paidBy === m.id
                  ? 'bg-ink text-white ring-transparent dark:bg-white dark:text-ink'
                  : 'bg-white text-ink ring-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-800'
              }`}
            >
              {m.id === me?.user.id ? 'Yo' : m.displayName}
            </button>
          ))}
        </div>
      )}

      {items.length === 0 && (
        <div className="card text-sm text-ink-mute dark:text-slate-400">
          No hay movimientos en este mes.
        </div>
      )}

      {Object.entries(byDay).map(([day, txs]) => (
        <div key={day}>
          <p className="px-1 pb-1.5 pt-2 text-xs font-medium uppercase tracking-wide text-ink-mute dark:text-slate-400">
            {dayLabel(day)}
          </p>
          <div className="card divide-y divide-slate-100 p-0 dark:divide-slate-800">
            {txs.map((t) => (
              <div key={t.id} className="flex items-center gap-3 p-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                  style={{ backgroundColor: `${t.categoryColor ?? '#94a3b8'}22` }}
                >
                  {t.type === 'transferencia' ? '⇄' : t.categoryIcon ?? '•'}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {t.merchantName ?? t.note ?? t.categoryName ?? 'Sin detalle'}
                  </p>
                  <p className="truncate text-xs text-ink-mute dark:text-slate-400">
                    {t.type === 'transferencia'
                      ? 'Transferencia'
                      : `${t.categoryName ?? 'Sin categoría'} · ${t.accountName ?? ''}`}
                    {miembros.length > 1 && t.type !== 'transferencia' && nombreDe(t.paidByUserId) && (
                      <span className="text-ink-soft dark:text-slate-300">
                        {' · '}
                        {t.paidByUserId === me?.user.id ? 'vos' : nombreDe(t.paidByUserId)}
                      </span>
                    )}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className={`tabular text-sm font-semibold ${
                    t.type === 'ingreso'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : t.type === 'transferencia'
                        ? 'text-ink-mute dark:text-slate-400'
                        : ''
                  }`}>
                    {t.type === 'ingreso' ? '+' : t.type === 'gasto' ? '−' : ''}
                    {money(t.amountMinor, t.currency as 'ARS' | 'USD', false)}
                  </p>
                  {t.type === 'transferencia' && t.amountToMinor != null
                    && t.currencyTo !== t.currency && (
                    <p className="tabular text-xs text-ink-mute dark:text-slate-400">
                      → {money(t.amountToMinor, t.currencyTo as 'ARS' | 'USD', false)}
                    </p>
                  )}
                </div>

                <button
                  onClick={() => remove(t.id)}
                  className="shrink-0 px-1 text-lg text-slate-300 hover:text-red-500 dark:text-slate-600"
                  aria-label="Borrar"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
