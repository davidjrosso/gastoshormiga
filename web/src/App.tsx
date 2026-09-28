import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { CreditCard, ShoppingCart } from 'lucide-react';
import { ApiError, api, type Me } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Movimientos from './pages/Movimientos';
import Hormiga from './pages/Hormiga';
import Ahorros from './pages/Ahorros';
import Fijos from './pages/Fijos';
import Ajustes from './pages/Ajustes';
import Categorias from './pages/Categorias';
import QuickAdd from './components/QuickAdd';
import Tarjetas from './pages/Tarjetas';
import Eventos from './pages/Eventos';
import Compras from './pages/Compras';
import ShoppingProvider, { ShoppingCount } from './components/ShoppingProvider';
import ShoppingEditor from './components/ShoppingEditor';
import { forgetOfflineProfile, offlineProfile, rememberOfflineProfile } from './lib/offline-session';

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
  const onStatements = useLocation().pathname === '/tarjetas';
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const reload = useCallback(async () => {
    try {
      const profile = await api.me();
      rememberOfflineProfile(profile);
      setMe(profile);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { forgetOfflineProfile(); setMe(null); }
      else if (!(err instanceof ApiError)) setMe(offlineProfile());
      else console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const expired = () => { forgetOfflineProfile(); setMe(null); setShoppingOpen(false); setAddOpen(false); };
    window.addEventListener('hormiga-session-expired', expired);
    window.addEventListener('online', reload);
    return () => {
      window.removeEventListener('hormiga-session-expired', expired);
      window.removeEventListener('online', reload);
    };
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
      <ShoppingProvider key={`${me.household.id}:${me.user.id}`} me={me}>
      <RefreshContext.Provider
        value={{ token: refreshToken, bump: () => setRefreshToken((t) => t + 1) }}
      >
        <div className={`mx-auto min-h-screen pb-24 ${onStatements ? 'max-w-[1440px]' : 'max-w-2xl'}`}>
          <div className="flex items-center justify-between px-4 pt-3">
            <span className="text-sm font-semibold text-ink-mute dark:text-slate-400">
              {me.household.name} <small className="ml-2 font-normal">v{import.meta.env.VITE_APP_VERSION}</small>
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
            <Route path="/compras" element={<Compras />} />
            <Route path="/fijos" element={<Fijos />} />
            <Route path="/ajustes" element={<Ajustes />} />
            {/* Fuera de la barra inferior a propósito: se configura una vez
                cada tanto, no es una pantalla de uso diario. */}
            <Route path="/categorias" element={<Categorias />} />
            <Route path="/tarjetas" element={<Tarjetas />} />
            <Route path="/eventos" element={<Eventos />} />
          </Routes>
        </div>

        {!onStatements && <button
          onClick={() => setAddOpen(true)}
          aria-label="Cargar gasto"
          className="fixed bottom-20 right-4 z-30 h-14 w-14 rounded-full bg-ant text-3xl
                     leading-none text-white shadow-lg transition active:scale-95
                     sm:right-[max(1rem,calc(50%-19rem))]"
        >
          +
        </button>}

        <BottomNav />
        {!onStatements && <button onClick={() => setShoppingOpen(true)} aria-label="Agregar producto a Compras"
          className="fixed bottom-36 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg transition active:scale-95 sm:right-[max(1rem,calc(50%-19rem))]">
          <ShoppingCart size={26} />
        </button>}
        {shoppingOpen && <ShoppingEditor onClose={() => setShoppingOpen(false)} />}

        {addOpen && (
          <QuickAdd
            onClose={() => setAddOpen(false)}
            onSaved={() => setRefreshToken((t) => t + 1)}
          />
        )}
      </RefreshContext.Provider>
      </ShoppingProvider>
    </AuthContext.Provider>
  );
}

const NAV = [
  { to: '/', label: 'Resumen', icon: '◎' },
  { to: '/movimientos', label: 'Movimientos', icon: '≡' },
  { to: '/hormiga', label: 'Hormiga', icon: '🐜' },
  { to: '/compras', label: 'Compras', icon: 'shopping' },
  { to: '/fijos', label: 'Fijos', icon: '↻' },
  { to: '/tarjetas', label: 'Tarjetas', icon: 'card' },
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
            <span className="text-lg leading-none">{item.icon === 'card' ? <CreditCard size={18}/> : item.icon === 'shopping' ? <ShoppingCart size={18}/> : item.icon}</span>
            <span>{item.label}{item.icon === 'shopping' && <ShoppingCount />}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
