import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, api, type Me } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Movimientos from './pages/Movimientos';
import Hormiga from './pages/Hormiga';
import Ahorros from './pages/Ahorros';
import Fijos from './pages/Fijos';
import Ajustes from './pages/Ajustes';
import Importar from './pages/Importar';
import Categorias from './pages/Categorias';
import QuickAdd from './components/QuickAdd';

/** Pantallas con su propia barra de acción abajo, donde el botón flotante
 *  de carga rápida estorba en vez de ayudar. */
const SIN_CARGA_RAPIDA = ['/importar'];

interface AuthState {
  me: Me | null;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ me: null, reload: async () => {} });
export const useAuth = () => useContext(AuthContext);

/** Hace que cualquier pantalla pueda pedir "recargá los datos" tras un alta. */
const RefreshContext = createContext<{ token: number; bump: () => void }>({
  token: 0,
  bump: () => {},
});
export const useRefresh = () => useContext(RefreshContext);

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const location = useLocation();
  const [refreshToken, setRefreshToken] = useState(0);

  const reload = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Al entrar, materializa los gastos fijos del mes. Es idempotente, así que
  // no importa que se dispare cada vez que se abre la app.
  useEffect(() => {
    if (!me) return;
    api.generateRecurring()
      .then((r) => { if (r.created > 0) setRefreshToken((t) => t + 1); })
      .catch(() => { /* sin conexión no pasa nada: se genera la próxima vez */ });
  }, [me]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-mute">
        cargando…
      </div>
    );
  }

  if (!me) return <Login onLogin={reload} />;

  return (
    <AuthContext.Provider value={{ me, reload }}>
      <RefreshContext.Provider
        value={{ token: refreshToken, bump: () => setRefreshToken((t) => t + 1) }}
      >
        <div className="mx-auto min-h-screen max-w-2xl pb-24">
          <div className="flex items-center justify-between px-4 pt-3">
            <span className="text-sm font-semibold text-ink-mute dark:text-slate-400">
              {me.household.name}
            </span>
            <NavLink
              to="/ajustes"
              className="rounded-lg px-2 py-1 text-lg text-ink-mute dark:text-slate-400"
              aria-label="Ajustes"
            >
              ⚙
            </NavLink>
          </div>

          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/movimientos" element={<Movimientos />} />
            <Route path="/hormiga" element={<Hormiga />} />
            <Route path="/ahorros" element={<Ahorros />} />
            <Route path="/fijos" element={<Fijos />} />
            <Route path="/ajustes" element={<Ajustes />} />
            {/* Fuera de la barra inferior a propósito: se configura una vez
                cada tanto, no es una pantalla de uso diario. */}
            <Route path="/categorias" element={<Categorias />} />
            <Route path="/importar" element={<Importar />} />
          </Routes>
        </div>

        {/* El botón de carga rápida se esconde donde hay una barra de acción
            propia: ahí se superpone con el botón que el usuario tiene que
            tocar, y encima ofrece cargar un gasto a mano justo cuando está
            importando ochenta de una. */}
        {!SIN_CARGA_RAPIDA.includes(location.pathname) && (
          <button
            onClick={() => setAddOpen(true)}
            aria-label="Cargar gasto"
            className="fixed bottom-20 right-4 z-30 h-14 w-14 rounded-full bg-ant text-3xl
                       leading-none text-white shadow-lg transition active:scale-95
                       sm:right-[max(1rem,calc(50%-19rem))]"
          >
            +
          </button>
        )}

        <BottomNav />

        {addOpen && (
          <QuickAdd
            onClose={() => setAddOpen(false)}
            onSaved={() => setRefreshToken((t) => t + 1)}
          />
        )}
      </RefreshContext.Provider>
    </AuthContext.Provider>
  );
}

const NAV = [
  { to: '/', label: 'Resumen', icon: '◎' },
  { to: '/movimientos', label: 'Movimientos', icon: '≡' },
  { to: '/hormiga', label: 'Hormiga', icon: '🐜' },
  { to: '/ahorros', label: 'Ahorros', icon: '$' },
  { to: '/fijos', label: 'Fijos', icon: '↻' },
];

function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur
                 dark:border-slate-800 dark:bg-slate-900/95"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-2xl">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] transition ${
                isActive
                  ? 'text-ant font-semibold'
                  : 'text-ink-mute dark:text-slate-400'
              }`
            }
          >
            <span className="text-lg leading-none">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
