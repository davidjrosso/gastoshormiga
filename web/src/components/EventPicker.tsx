import { useEffect, useId, useState } from 'react';
import { useRefresh } from '../App';
import { api, type HouseholdEvent } from '../lib/api';

export default function EventPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const id = useId();
  const { token } = useRefresh();
  const [events, setEvents] = useState<HouseholdEvent[]>([]);
  const [name, setName] = useState('');
  const [extraordinary, setExtraordinary] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    api.events().then(rows => { if (active) { setEvents(rows); setError(''); } })
      .catch(() => { if (active) setError('No se pudieron cargar los eventos.'); });
    return () => { active = false; };
  }, [token, retry]);
  async function create() {
    setBusy(true); setError('');
    try {
      const event = await api.createEvent(name, extraordinary);
      setEvents(rows => [event, ...rows]); onChange(event.id); setName(''); setCreating(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo crear el evento.'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    <label className="label" htmlFor={id}>Evento</label>
    <select id={id} className="input" value={value ?? ''} onChange={e => onChange(e.target.value || null)} disabled={busy}>
      <option value="">Sin evento</option>
      {events.filter(e => !e.archived || e.id === value).map(e => <option key={e.id} value={e.id}>{e.name}{e.archived ? ' (archivado)' : ''}</option>)}
    </select>
    {!creating ? <button type="button" className="text-sm text-ant underline" onClick={() => setCreating(true)}>Crear evento</button> : <div className="space-y-2 rounded-lg border border-slate-300 p-2 dark:border-slate-700">
      <label className="label" htmlFor={`${id}-name`}>Nombre del nuevo evento</label>
      <input id={`${id}-name`} className="input" value={name} maxLength={100} placeholder="Vacaciones Córdoba" onChange={e => setName(e.target.value)} disabled={busy} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={extraordinary} onChange={e => setExtraordinary(e.target.checked)} disabled={busy} />Extraordinario: excluir de tendencias habituales</label>
      <div className="flex gap-2"><button type="button" className="btn-primary" onClick={create} disabled={busy || !name.trim()}>{busy ? 'Creando…' : 'Crear y elegir'}</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => setCreating(false)}>Cancelar</button></div>
    </div>}
    {error && <p className="text-sm text-red-600" role="alert">{error} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Reintentar carga</button></p>}
  </div>;
}
