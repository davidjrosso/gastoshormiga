import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRefresh } from '../App';
import EditTransaction from '../components/EditTransaction';
import { api, type HouseholdEvent, type Transaction } from '../lib/api';
import { dayLabel, money } from '../lib/format';

export default function Eventos() {
  const formRef = useRef<HTMLDivElement>(null);
  const { token, bump } = useRefresh();
  const [events, setEvents] = useState<HouseholdEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [extraordinary, setExtraordinary] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.events().then(rows => { if (active) { setEvents(rows); setError(''); } })
      .catch(() => { if (active) setError('No se pudieron cargar los eventos.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);
  async function save() {
    setBusy(true); setError('');
    try {
      if (editing) await api.updateEvent(editing, { name, extraordinary });
      else await api.createEvent(name, extraordinary);
      setEditing(null); setName(''); setExtraordinary(true); bump();
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  }
  async function archive(event: HouseholdEvent) {
    setBusy(true); setError('');
    try { await api.updateEvent(event.id, { archived: !event.archived }); bump(); }
    catch (err) { setError(err instanceof Error ? err.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 p-3">
    <header className="px-1 pt-2"><h1 className="text-lg font-bold">Eventos</h1><p className="mt-1 text-sm text-ink-mute dark:text-slate-400">Agrupá gastos como vacaciones o cumpleaños. Los extraordinarios quedan fuera de las tendencias, pero siguen contando en el total del mes y en las cuotas comprometidas.</p></header>
    <div ref={formRef} className="card space-y-3">
      <h2 className="font-semibold">{editing ? 'Editar evento' : 'Nuevo evento'}</h2>
      <label className="label block" htmlFor="event-name">Nombre</label><input id="event-name" className="input" value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="Vacaciones Córdoba 2027" disabled={busy} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={extraordinary} onChange={e => setExtraordinary(e.target.checked)} disabled={busy} />Extraordinario: excluir sus gastos de las tendencias habituales</label>
      {editing && <p className="text-xs text-ink-mute">Cambiar esta opción actualiza también las comparaciones de meses anteriores.</p>}
      <div className="flex gap-2"><button className="btn-primary" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Guardando…' : editing ? 'Guardar evento' : 'Crear evento'}</button>{editing && <button className="btn-ghost" disabled={busy} onClick={() => { setEditing(null); setName(''); setExtraordinary(true); }}>Cancelar edición</button>}</div>
    </div>
    <Link className="card block text-sm text-ant" to="/movimientos">Asignar eventos a uno o varios gastos desde Movimientos →</Link>
    {error && <p className="card text-sm text-red-600" role="alert">{error} <button className="underline" onClick={bump}>Recargar</button></p>}
    <label className="flex items-center gap-2 px-1 text-sm"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />Mostrar archivados</label>
    {loading && <p role="status" className="text-sm">Cargando eventos…</p>}
    {!loading && !events.filter(e => showArchived || !e.archived).length && <p className="card text-sm">Todavía no hay eventos {showArchived ? '' : 'activos'}. Creá uno para agrupar tus gastos.</p>}
    {events.filter(e => showArchived || !e.archived).map(event => <section key={event.id} className="card space-y-2">
      <h2 className="break-words font-semibold">{event.name}{event.archived && ' · Archivado'}</h2>
      <p className="text-xs text-ink-mute dark:text-slate-400">{event.extraordinary ? 'Extraordinario · fuera de tendencias' : 'Incluido en tendencias habituales'}</p>
      <p className="tabular text-lg font-semibold">{money(event.arsMinor)}{event.usdCents !== 0 && ` + ${money(event.usdCents, 'USD')}`}</p>
      <p className="text-xs text-ink-mute dark:text-slate-400">{event.expenseCount} movimientos confirmados, de todos los meses. Los reintegros restan; las cuotas futuras se ven en Cuotas comprometidas.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" aria-expanded={expanded === event.id} onClick={() => setExpanded(expanded === event.id ? null : event.id)}>{expanded === event.id ? 'Ocultar gastos' : 'Ver gastos'}</button>
        <button className="btn-ghost" disabled={busy} onClick={() => { setEditing(event.id); setName(event.name); setExtraordinary(event.extraordinary); formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Editar evento</button>
        <button className="btn-ghost" disabled={busy} onClick={() => archive(event)}>{event.archived ? 'Reactivar' : 'Archivar'}</button>
      </div>
      {expanded === event.id && <EventExpenses key={`${event.id}:${token}`} eventId={event.id} />}
    </section>)}
    <p className="px-1 text-xs text-ink-mute dark:text-slate-400">Archivar oculta el evento de las nuevas asignaciones. Conserva sus gastos, su efecto en las tendencias y las cuotas ya vinculadas.</p>
  </div>;
}

function EventExpenses({ eventId }: { eventId: string }) {
  const { bump } = useRefresh();
  const [items, setItems] = useState<Transaction[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<Transaction | null>(null);
  useEffect(() => {
    let active = true; setBusy(true); setError(false);
    api.transactions({ eventId, type: 'gasto', limit: 50, offset }).then(rows => {
      if (active) { setItems(old => offset === 0 ? rows : [...old, ...rows]); setMore(rows.length === 50); }
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [eventId, offset, retry]);
  return <div className="space-y-2 border-t border-slate-200 pt-2 dark:border-slate-800">
    {items.map(tx => <button key={tx.id} className="block w-full rounded-lg bg-slate-50 p-2 text-left text-sm dark:bg-slate-800" onClick={() => setEditing(tx)}>
      <span className="block break-words font-medium">{tx.merchantName || tx.note || 'Sin detalle'}</span><span className="tabular">{money(tx.amountMinor, tx.currency as 'ARS' | 'USD')}</span><span className="block text-xs text-ink-mute">{dayLabel(tx.date)} · {tx.date.slice(0,4)} · {tx.categoryName ?? 'Sin categoría'}</span>
    </button>)}
    {busy && <p role="status" className="text-sm">Cargando gastos…</p>}
    {error && <p role="alert" className="text-sm">No se pudieron cargar los gastos. <button className="underline" onClick={() => setRetry(n => n + 1)}>Reintentar</button></p>}
    {!busy && !error && more && <button className="btn-ghost" onClick={() => setOffset(items.length)}>Cargar más gastos</button>}
    {editing && <EditTransaction tx={editing} onClose={() => setEditing(null)} onSaved={bump} />}
  </div>;
}
