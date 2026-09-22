import { useEffect, useState } from 'react';
import { Save, ListPlus } from 'lucide-react';
import { holderKey, statements, type StatementRecord } from '../lib/statements';
import { useRefresh } from '../App';

export default function StatementMovements({ record }: { record: StatementRecord }) {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { bump } = useRefresh();
  useEffect(() => {
    let current = true;
    statements.movementSettings().then(v => {
      if (!current) return;
      setUsers(v.users);
      setMapping(Object.fromEntries(v.mappings.map(m => [holderKey(m.holder), m.userId ?? ''])));
      setLoaded(true);
    }).catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, []);
  async function save() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await statements.configureMovements(record.id, record.document.holders.map(h => ({
        holder: h.holder, userId: mapping[holderKey(h.holder)] || null,
      })));
      setNotice(result.deferred ? 'Seleccion guardada. Pendiente de confirmar el resumen.' :
        `${result.created} movimientos nuevos. ${result.linked} vinculados al resumen.`);
      bump();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar la seleccion.'); }
    finally { setBusy(false); }
  }
  return <section className="st-movement-users">
    <h2>Movimientos del hogar</h2>
    <fieldset disabled={busy || !loaded}>
      <div className="st-metadata">
        {record.document.holders.map(h => <label key={h.holder}>
          {h.holder}
          <select className="st-input" value={mapping[holderKey(h.holder)] ?? ''}
            onChange={e => setMapping({ ...mapping, [holderKey(h.holder)]: e.target.value })}>
            <option value="">Solo liquidacion</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>)}
      </div>
      <button className="btn-ghost st-command" onClick={() => void save()}>
        {record.status === 'confirmed' ? <ListPlus size={18} /> : <Save size={18} />}
        {busy ? 'Guardando...' : record.status === 'confirmed' ? 'Incorporar a movimientos' : 'Guardar seleccion'}
      </button>
    </fieldset>
    {error && <p className="st-error" role="alert">{error}</p>}
    {notice && <p className="st-status" role="status">{notice}</p>}
  </section>;
}
