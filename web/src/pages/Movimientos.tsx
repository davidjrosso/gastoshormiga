import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useRefresh } from '../App';
import EditTransaction from '../components/EditTransaction';
import Installments from '../components/Installments';
import EventPicker from '../components/EventPicker';
import { api, type Transaction, type HouseholdEvent } from '../lib/api';
import { currentPeriod, dayLabel, money, periodLabel, shiftPeriod } from '../lib/format';

export default function Movimientos() {
  const [period, setPeriod] = useState(currentPeriod());
  const [items, setItems] = useState<Transaction[]>([]);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [filter, setFilter] = useState<'todos' | 'gasto' | 'ingreso' | 'transferencia'>('todos');
  const [paidBy, setPaidBy] = useState<string>('');
  const [events, setEvents] = useState<HouseholdEvent[]>([]);
  const [eventFilter, setEventFilter] = useState('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetEvent, setTargetEvent] = useState<string | null>(null);
  const [allInstallments, setAllInstallments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { token, bump } = useRefresh();
  const { me } = useAuth();

  const miembros = me?.members ?? [];
  /** Resuelve el nombre sin pedirle nada más al servidor: los integrantes del
   *  hogar ya vienen en /auth/me, y son dos. */
  const nombreDe = (userId: string | null) =>
    miembros.find((m) => m.id === userId)?.displayName ?? null;

  useEffect(() => {
    let active = true;
    setSelected([]); setAllInstallments(false); setItems([]); setError('');
    api.transactions({
      period,
      type: filter === 'todos' ? undefined : filter,
      paidBy: paidBy || undefined,
      limit: 500,
      eventId: eventFilter === 'all' ? undefined : eventFilter === 'none' ? null : eventFilter,
    })
      .then(rows => { if (active) setItems(rows); })
      .catch(() => { if (active) setError('No se pudieron cargar los movimientos.'); });
    return () => { active = false; };
  }, [period, filter, paidBy, token, eventFilter]);

  useEffect(() => {
    let active = true;
    api.events().then(rows => { if (active) setEvents(rows); }).catch(() => { if (active) setError('No se pudieron cargar los eventos.'); });
    return () => { active = false; };
  }, [token]);

  async function applyEvent() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.assignEvent(selected, targetEvent, allInstallments);
      setNotice(`Evento actualizado en ${result.updated} movimientos.`); setSelected([]); setSelecting(false); bump();
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo aplicar el evento.'); }
    finally { setBusy(false); }
  }

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
                aria-label="Mes siguiente">›</button>
      </header>
      <div className="card space-y-2">
        <label htmlFor="event-filter" className="label">Filtrar por evento</label>
        <select id="event-filter" className="input" value={eventFilter} onChange={e => setEventFilter(e.target.value)} disabled={busy}>
          <option value="all">Todos los eventos y sin evento</option><option value="none">Sin evento</option>
          {events.map(e => <option key={e.id} value={e.id}>{e.name}{e.archived ? ' (archivado)' : ''}</option>)}
        </select>
        <div className="flex flex-wrap items-center gap-3"><Link to="/eventos" className="text-sm text-ant underline">Gestionar eventos</Link><button className="btn-ghost" disabled={busy} onClick={() => { setSelecting(!selecting); setSelected([]); setAllInstallments(false); }}>{selecting ? 'Cancelar selección' : 'Seleccionar gastos'}</button></div>
      </div>
      {selecting && <div className="card space-y-3">
        <p className="text-sm">{selected.length} gastos seleccionados. Elegí un evento o “Sin evento” para quitar la etiqueta.</p>
        <button className="btn-ghost" disabled={busy} onClick={() => { setSelected(items.filter(t => t.type === 'gasto').map(t => t.id)); setAllInstallments(false); }}>Seleccionar gastos visibles</button>
        <fieldset disabled={busy}><EventPicker value={targetEvent} onChange={setTargetEvent} /></fieldset>
        {selected.length > 0 && selected.every(id => items.find(t => t.id === id)?.canApplyEventToPurchase) && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={allInstallments} disabled={busy} onChange={e => setAllInstallments(e.target.checked)} />Incluir las otras cuotas de estas compras y las de próximos resúmenes.</label>}
        <button className="btn-primary" onClick={applyEvent} disabled={busy || !selected.length}>{busy ? 'Aplicando…' : 'Aplicar evento a la selección'}</button>
      </div>}
      {error && <p className="card text-sm text-red-600" role="alert">{error} <button className="underline" onClick={bump}>Recargar</button></p>}
      {notice && <p className="card text-sm" role="status">{notice}</p>}

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

      {(filter === 'todos' || filter === 'gasto') && <Installments period={period} months={1} paidBy={paidBy} eventId={eventFilter === 'all' ? undefined : eventFilter === 'none' ? null : eventFilter} />}
      {items.length === 500 && <p className="px-1 text-xs text-ink-mute">Mostrando los primeros 500 movimientos. Filtrá por persona o evento para acotar la selección.</p>}

      {items.length === 0 && (
        <div className="card text-sm text-ink-mute dark:text-slate-400">
          No hay movimientos confirmados en este mes.
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
                {selecting && t.type === 'gasto' && <input type="checkbox" disabled={busy} aria-label={`Seleccionar ${t.merchantName ?? t.note ?? 'gasto'}`} checked={selected.includes(t.id)} onChange={e => { setSelected(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id)); setAllInstallments(false); }} />}
                {/* El renglón entero abre la edición. El blanco de toque en un
                    celular tiene que ser la fila, no un ícono de lápiz de 16px. */}
                <button
                  onClick={() => setEditing(t)} disabled={busy}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-label={`Editar ${t.merchantName ?? t.note ?? t.categoryName ?? 'movimiento'}`}
                >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                  style={{ backgroundColor: `${t.categoryColor ?? '#94a3b8'}22` }}
                >
                  {t.type === 'transferencia' ? '⇄' : t.categoryIcon ?? '•'}
                </span>

                <div className="min-w-0 flex-1">
                  {t.eventName && <p className="truncate text-xs text-ant">Evento: {t.eventName}</p>}
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
                    {t.type === 'ingreso' ? '+' : t.type === 'gasto' ? (t.amountMinor < 0 ? '+' : '−') : ''}
                    {money(Math.abs(t.amountMinor), t.currency as 'ARS' | 'USD', false)}
                  </p>
                  {t.type === 'transferencia' && t.amountToMinor != null
                    && t.currencyTo !== t.currency && (
                    <p className="tabular text-xs text-ink-mute dark:text-slate-400">
                      → {money(t.amountToMinor, t.currencyTo as 'ARS' | 'USD', false)}
                    </p>
                  )}
                </div>
                </button>

                <button
                  onClick={() => remove(t.id)}
                  disabled={!!t.statementId}
                  title={t.statementId ? 'Vinculado a resumen confirmado' : 'Borrar movimiento'}
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

      {editing && (
        <EditTransaction
          tx={editing}
          onClose={() => setEditing(null)}
          onSaved={bump}
        />
      )}
    </div>
  );
}
