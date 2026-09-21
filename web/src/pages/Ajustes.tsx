import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../App';
import { api } from '../lib/api';

export default function Ajustes() {
  const { me } = useAuth();
  const [copied, setCopied] = useState(false);
  const [rate, setRate] = useState('');
  const [rateSaved, setRateSaved] = useState(false);

  if (!me) return null;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(me!.household.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* En http sin TLS el portapapeles puede estar bloqueado: queda a mano
         para seleccionarlo manualmente, que es el fallback razonable. */
    }
  }

  async function saveRate() {
    await api.setFxManual({ sell: rate });
    setRate('');
    setRateSaved(true);
    setTimeout(() => setRateSaved(false), 2000);
  }

  return (
    <div className="space-y-3 p-3">
      <header className="px-1 pt-2">
        <h1 className="text-lg font-bold">Ajustes</h1>
      </header>

      <div className="card">
        <p className="label">Hogar</p>
        <p className="mt-1 font-semibold">{me.household.name}</p>
        <p className="mt-3 text-sm text-ink-mute dark:text-slate-400">
          {me.members.length === 1
            ? 'Por ahora estás solo en este hogar.'
            : `${me.members.length} personas cargando gastos:`}
        </p>
        <ul className="mt-1 space-y-0.5">
          {me.members.map((m) => (
            <li key={m.id} className="text-sm">
              {m.displayName}
              {m.id === me.user.id && (
                <span className="ml-1 text-xs text-ink-mute dark:text-slate-400">(vos)</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <Link to="/categorias" className="card flex items-center justify-between">
        <div>
          <p className="label">Categorías</p>
          <p className="mt-1 text-sm">Crear, editar y archivar</p>
        </div>
        <span className="text-xl text-ink-mute">›</span>
      </Link>

      {/* Vive en Ajustes y no en la barra de abajo a propósito: importar un
          resumen se hace una vez al mes, y la navegación principal es para lo
          que se usa todos los días. */}
      <Link to="/importar" className="card flex items-center justify-between">
        <div>
          <p className="label">Importar resumen</p>
          <p className="mt-1 text-sm">Cargar el PDF de la tarjeta de una vez</p>
        </div>
        <span className="text-xl text-ink-mute">›</span>
      </Link>

      <div className="card">
        <p className="label">Código de invitación</p>
        <p className="mt-1 break-all rounded-xl bg-slate-100 px-3 py-2 font-mono text-xs dark:bg-slate-800">
          {me.household.inviteCode}
        </p>
        <button className="btn-ghost mt-2 w-full" onClick={copyInvite}>
          {copied ? 'Copiado' : 'Copiar'}
        </button>
        <p className="mt-2 text-xs text-ink-mute dark:text-slate-400">
          Tu pareja lo pega al crear su cuenta y entra a este mismo hogar.
          Compartilo por un canal privado: quien lo tenga puede sumarse
          y ver todos los movimientos.
        </p>
      </div>

      <div className="card">
        <p className="label">Cotización manual del dólar</p>
        <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
          La app trae el blue sola. Usá esto si el servidor no tiene salida a
          internet, o si querés fijar el valor al que vos compraste.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            className="input tabular flex-1" inputMode="decimal" placeholder="1450"
            value={rate} onChange={(e) => setRate(e.target.value)}
          />
          <button className="btn-primary" onClick={saveRate} disabled={!rate}>
            {rateSaved ? 'Guardado' : 'Guardar'}
          </button>
        </div>
      </div>

      <div className="card">
        <p className="label">Instalar en el celular</p>
        <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
          En Chrome para Android: menú de tres puntos → "Instalar aplicación".
          Queda con ícono propio y se abre a pantalla completa, igual que
          cualquier app. En iPhone, Safari → Compartir → "Agregar a inicio".
        </p>
      </div>

      <div className="card">
        <p className="label">Sesión</p>
        <p className="mt-1 text-sm">{me.user.email}</p>
        <button
          className="btn-ghost mt-3 w-full text-red-600 dark:text-red-400"
          onClick={async () => { await api.logout(); location.reload(); }}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
