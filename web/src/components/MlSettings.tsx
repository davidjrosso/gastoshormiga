import { useCallback, useEffect, useState } from 'react';
import { useShoppingApi, type MlStatus } from '../lib/ml';

export default function MlSettings() {
  const api = useShoppingApi('Mercado Libre');
  const [status, setStatus] = useState<MlStatus | null>(null);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false); const [pasted, setPasted] = useState('');
  const load = useCallback(() => api<MlStatus>('/stores/ml/status').then(setStatus).catch(e => setMessage((e as Error).message)), [api]);
  useEffect(() => {
    void load();
    // Vuelta desde el callback del servidor: /ajustes?ml=conectado
    const params = new URLSearchParams(window.location.search);
    if (params.get('ml') === 'conectado') {
      setMessage('Mercado Libre quedó conectado.');
      params.delete('ml'); const rest = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    }
  }, [load]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  const connect = () => {
    // Se abre la pestaña en el mismo toque (si no, el navegador la bloquea tras la espera)
    // y se corta el vínculo con esta ventana antes de ir a Mercado Libre.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    return run(async () => {
      try {
        const { authUrl } = await api<{ authUrl: string }>('/stores/ml/connect', 'POST');
        if (tab) tab.location.href = authUrl; else window.location.assign(authUrl);
        setWaiting(true);
      } catch (e) { tab?.close(); throw e; }
    });
  };
  const complete = () => run(async () => {
    setStatus(await api<MlStatus>('/stores/ml/complete', 'POST', { url: pasted.trim() }));
    setWaiting(false); setPasted(''); setMessage('Mercado Libre quedó conectado.');
  });
  const disconnect = () => run(async () => { setStatus(await api<MlStatus>('/stores/ml/connection', 'DELETE')); setMessage('Mercado Libre desconectado. Los productos elegidos se conservan.'); });
  return <section className="card space-y-2"><h2 className="label">Mercado Libre · Comparar con VEA</h2>
    {!status ? <p className="text-sm">Consultando…</p> : !status.configured ? <p className="text-sm">Mercado Libre no está configurado en el servidor.</p> : status.connected
      ? <><p className="text-sm">Conectado por {status.connectedBy}{status.connectedAt ? ` · ${new Date(status.connectedAt).toLocaleDateString('es-AR')}` : ''}.</p>
        <p className="text-xs text-ink-mute dark:text-slate-400">Hormiga solo consulta catálogo, ofertas Full y costos de envío a tu código postal. No compra ni lee tus compras.</p>
        <button className="btn-ghost text-sm" disabled={busy} onClick={() => void disconnect()}>Desconectar</button></>
      : <><p className="text-xs text-ink-mute dark:text-slate-400">Conectá tu cuenta para comparar la lista con ofertas Full. Vas a iniciar sesión en Mercado Libre, no en Hormiga.</p>
        <button className="btn-primary text-sm" disabled={busy} onClick={() => void connect()}>{busy ? 'Abriendo…' : 'Conectar Mercado Libre'}</button>
        {waiting && <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800">
          <p>Autorizá en la pestaña de Mercado Libre. Si al volver el navegador muestra un aviso o un error, copiá la dirección completa de esa pestaña y pegala acá:</p>
          <input className="input w-full" aria-label="Dirección de vuelta de Mercado Libre" inputMode="url" autoComplete="off" value={pasted} onChange={e => setPasted(e.target.value)} placeholder="https://…/hormiga/api/ml/callback?code=…" />
          <div className="flex gap-2"><button className="btn-primary text-sm" disabled={busy || pasted.trim().length < 10} onClick={() => void complete()}>Terminar conexión</button><button className="btn-ghost text-sm" disabled={busy} onClick={() => void load().then(() => setWaiting(false))}>Ya volví conectado</button></div>
        </div>}</>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
