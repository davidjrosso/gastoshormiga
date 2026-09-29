import { useEffect, useState } from 'react';
import { useVeaApi, type VeaSettings as Settings } from '../lib/vea';

export default function VeaSettings() {
  const api = useVeaApi(); const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; api<Settings>('/settings').then(s => { if (active) setSettings(s); }).catch(e => { if (active) setMessage(e.message); }); return () => { active = false; }; }, [api]);
  async function save() {
    if (!settings) return;
    setBusy(true); setMessage('');
    try { setSettings(await api<Settings>('/settings', 'PUT', { salesChannel: settings.salesChannel, sellerId: settings.sellerId })); setMessage('Sucursal guardada para el hogar.'); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="card space-y-2"><h2 className="label">VEA · Cotizar compras</h2>
    <p className="text-sm">{settings?.label ?? 'Vea Río Tercero (retiro)'}</p>
    <p className="text-xs text-ink-mute dark:text-slate-400">Por ahora esta es la única sucursal disponible. Confirmá retiro, horario y precio final en VEA. No necesitás guardar credenciales en Hormiga.</p>
    {settings && <button className="btn-ghost text-sm" disabled={busy || settings.saved} onClick={() => void save()}>{settings.saved ? 'Sucursal guardada' : busy ? 'Guardando…' : 'Usar esta sucursal'}</button>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
