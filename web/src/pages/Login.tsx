import { useState } from 'react';
import { ApiError, api } from '../lib/api';

/**
 * Login y alta. El modo "sumarme a un hogar" es lo que permite que la pareja
 * comparta los mismos datos en vez de terminar con dos planillas separadas,
 * que es exactamente el problema que esta app viene a resolver.
 */
export default function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [householdName, setHouseholdName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await api.login(email, password);
      } else {
        await api.register({
          email,
          password,
          displayName,
          householdName: householdName || undefined,
          inviteCode: inviteCode.trim() || undefined,
          registrationCode: registrationCode.trim() || undefined,
        });
      }
      await onLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {/* Ruta relativa al `base` de Vite: escrita como "/icons/..." se
              rompería al servir la app desde un subdirectorio. */}
          <img
            src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
            alt=""
            className="mx-auto mb-4 h-16 w-16 rounded-2xl"
          />
          <h1 className="text-2xl font-bold">hormiga</h1>
          <p className="mt-1 text-sm text-ink-mute dark:text-slate-400">
            La economía de casa, sin sorpresas a fin de mes.
          </p>
        </div>

        <form onSubmit={submit} className="card space-y-3">
          {mode === 'register' && (
            <div>
              <label className="label" htmlFor="name">Tu nombre</label>
              <input
                id="name" className="input mt-1" value={displayName} required
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="David"
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email" type="email" autoComplete="email" className="input mt-1"
              value={email} required onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="password">Contraseña</label>
            <input
              id="password" type="password" className="input mt-1"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password} required minLength={8}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {mode === 'register' && (
            <>
              <div>
                <label className="label" htmlFor="invite">Código de invitación</label>
                <input
                  id="invite" className="input mt-1" value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Si tu pareja ya creó el hogar, pegalo acá"
                />
                <p className="mt-1 text-xs text-ink-mute dark:text-slate-400">
                  Lo encontrás en Ajustes, en la cuenta de quien creó el hogar.
                  Si lo dejás vacío, se crea un hogar nuevo.
                </p>
              </div>

              {!inviteCode.trim() && (
                <div>
                  <label className="label" htmlFor="household">Nombre del hogar</label>
                  <input
                    id="household" className="input mt-1" value={householdName}
                    onChange={(e) => setHouseholdName(e.target.value)}
                    placeholder="Casa"
                  />
                </div>
              )}

              <div>
                <label className="label" htmlFor="regcode">Código de registro del servidor</label>
                <input
                  id="regcode" className="input mt-1" value={registrationCode}
                  onChange={(e) => setRegistrationCode(e.target.value)}
                  placeholder="Solo si el servidor lo pide"
                />
              </div>
            </>
          )}

          {error && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
          </button>

          <button
            type="button"
            className="w-full py-2 text-sm text-ink-mute underline dark:text-slate-400"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
          >
            {mode === 'login' ? 'No tengo cuenta todavía' : 'Ya tengo cuenta'}
          </button>
        </form>
      </div>
    </div>
  );
}
