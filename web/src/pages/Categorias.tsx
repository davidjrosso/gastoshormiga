import { useEffect, useState } from 'react';
import { useRefresh } from '../App';
import { api, type Category } from '../lib/api';

/** Paleta acotada a propósito: elegir entre 14 colores es rápido,
 *  elegir entre 16 millones con una rueda es una pérdida de tiempo. */
const COLORES = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#0ea5e9', '#6366f1', '#8b5cf6', '#d946ef', '#64748b',
];

const ICONOS = [
  '🛒', '🍽️', '☕', '🛵', '🚌', '⛽', '🏠', '🏢', '💡', '📶', '⚕️', '💊',
  '🎬', '👕', '🎓', '🐾', '🎁', '🔧', '📺', '🛡️', '📄', '💼', '💻', '🏷️',
  '🥬', '✈️', '📚', '🧾', '•',
];

export default function Categorias() {
  const [categorias, setCategorias] = useState<Category[]>([]);
  const [verArchivadas, setVerArchivadas] = useState(false);
  const [editando, setEditando] = useState<Category | null>(null);
  const [creando, setCreando] = useState<'gasto' | 'ingreso' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const { bump } = useRefresh();

  const cargar = () => {
    api.categories(true).then(setCategorias).catch(() => setError('No se pudieron cargar'));
  };

  useEffect(cargar, []);

  const mostrar = (kind: 'gasto' | 'ingreso') =>
    categorias.filter((c) => c.kind === kind && (verArchivadas || !c.archived));

  async function borrar(cat: Category) {
    const confirmado = confirm(
      `¿Borrar "${cat.name}"?\n\nSi tiene gastos cargados no se borra: se archiva, ` +
      `para no dejar huérfanos los movimientos viejos.`,
    );
    if (!confirmado) return;
    try {
      const r = await api.deleteCategory(cat.id);
      setAviso(r.accion === 'archivada'
        ? `"${cat.name}" tenía movimientos, así que la archivé en vez de borrarla.`
        : `"${cat.name}" se borró: no tenía ningún movimiento.`);
      setTimeout(() => setAviso(null), 5000);
      cargar();
      bump();
    } catch {
      setError('No se pudo borrar');
    }
  }

  async function revivir(cat: Category) {
    await api.updateCategory(cat.id, { archived: false });
    cargar();
    bump();
  }

  return (
    <div className="space-y-3 p-3">
      <header className="px-1 pt-2">
        <h1 className="text-lg font-bold">Categorías</h1>
        <p className="text-sm text-ink-mute dark:text-slate-400">
          Las que aparecen al cargar un gasto.
        </p>
      </header>

      {aviso && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {aviso}
        </p>
      )}
      {error && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {(['gasto', 'ingreso'] as const).map((kind) => (
        <div key={kind} className="card">
          <div className="mb-3 flex items-center justify-between">
            <p className="label">{kind === 'gasto' ? 'Gastos' : 'Ingresos'}</p>
            <button
              onClick={() => { setCreando(kind); setEditando(null); }}
              className="text-sm font-semibold text-ant"
            >
              + Agregar
            </button>
          </div>

          <div className="space-y-1">
            {mostrar(kind).map((c) => (
              <div
                key={c.id}
                className={`flex items-center gap-3 rounded-xl px-2 py-2 ${
                  c.archived ? 'opacity-45' : ''
                }`}
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                  style={{ backgroundColor: `${c.color}22` }}
                >
                  {c.icon}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {c.name}
                    {c.archived && (
                      <span className="ml-2 text-xs font-normal text-ink-mute">archivada</span>
                    )}
                  </p>
                  {c.isFixed && !c.archived && (
                    <p className="text-xs text-ink-mute dark:text-slate-400">gasto fijo</p>
                  )}
                </div>

                {c.archived ? (
                  <button onClick={() => revivir(c)} className="chip bg-slate-100 text-sm dark:bg-slate-800">
                    Recuperar
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => { setEditando(c); setCreando(null); }}
                      className="px-2 text-sm text-ink-mute dark:text-slate-400"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => borrar(c)}
                      className="px-1 text-lg text-slate-300 hover:text-red-500 dark:text-slate-600"
                      aria-label={`Borrar ${c.name}`}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
            {mostrar(kind).length === 0 && (
              <p className="px-2 py-3 text-sm text-ink-mute dark:text-slate-400">
                Todavía no hay ninguna.
              </p>
            )}
          </div>
        </div>
      ))}

      <button
        className="w-full py-2 text-sm text-ink-mute underline dark:text-slate-400"
        onClick={() => setVerArchivadas(!verArchivadas)}
      >
        {verArchivadas ? 'Ocultar archivadas' : 'Ver archivadas'}
      </button>

      {(editando || creando) && (
        <Editor
          categoria={editando}
          kind={editando?.kind ?? creando!}
          onCerrar={() => { setEditando(null); setCreando(null); }}
          onGuardado={() => { setEditando(null); setCreando(null); cargar(); bump(); }}
        />
      )}
    </div>
  );
}

function Editor({
  categoria, kind, onCerrar, onGuardado,
}: {
  categoria: Category | null;
  kind: 'gasto' | 'ingreso';
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [name, setName] = useState(categoria?.name ?? '');
  const [icon, setIcon] = useState(categoria?.icon ?? '•');
  const [color, setColor] = useState(categoria?.color ?? '#64748b');
  const [isFixed, setIsFixed] = useState(categoria?.isFixed ?? false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      if (categoria) {
        await api.updateCategory(categoria.id, { name, icon, color, isFixed });
      } else {
        await api.createCategory({ name, kind, icon, color, isFixed });
      }
      onGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onCerrar}>
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-slate-100 p-4 dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />

        <h2 className="mb-3 px-1 font-bold">
          {categoria ? 'Editar categoría' : `Nueva categoría de ${kind}`}
        </h2>

        <div className="card space-y-3">
          <div>
            <label className="label" htmlFor="nombre">Nombre</label>
            <input
              id="nombre" className="input mt-1" value={name} autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="Farmacia, Peluquería, Gimnasio…"
            />
          </div>

          <div>
            <p className="label mb-2">Ícono</p>
            <div className="flex flex-wrap gap-1.5">
              {ICONOS.map((i) => (
                <button
                  key={i}
                  onClick={() => setIcon(i)}
                  className={`flex h-10 w-10 items-center justify-center rounded-xl text-lg transition ${
                    icon === i
                      ? 'bg-ant/20 ring-2 ring-ant'
                      : 'bg-slate-100 dark:bg-slate-800'
                  }`}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="label mb-2">Color</p>
            <div className="flex flex-wrap gap-2">
              {COLORES.map((col) => (
                <button
                  key={col}
                  onClick={() => setColor(col)}
                  aria-label={`Color ${col}`}
                  className={`h-8 w-8 rounded-full transition ${
                    color === col ? 'ring-2 ring-ink ring-offset-2 dark:ring-white dark:ring-offset-slate-900' : ''
                  }`}
                  style={{ backgroundColor: col }}
                />
              ))}
            </div>
          </div>

          {kind === 'gasto' && (
            <label className="flex items-start gap-3 rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
              <input
                type="checkbox" checked={isFixed} className="mt-0.5 h-5 w-5 accent-ant"
                onChange={(e) => setIsFixed(e.target.checked)}
              />
              <span className="text-sm">
                <strong>Es un gasto fijo</strong>
                <span className="block text-ink-mute dark:text-slate-400">
                  Alquiler, expensas, prepaga. Separarlos del día a día es lo que
                  te deja ver cuánto gastás en lo que sí podés decidir.
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="card mt-3">
          <p className="label mb-2">Así se va a ver</p>
          <div className="flex items-center gap-3">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full text-base"
              style={{ backgroundColor: `${color}22` }}
            >
              {icon}
            </span>
            <span className="text-sm font-medium">{name || 'Sin nombre'}</span>
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="sticky bottom-0 mt-4 flex gap-2 bg-slate-100 py-3 dark:bg-slate-950">
          <button className="btn-ghost flex-1" onClick={onCerrar}>Cancelar</button>
          <button
            className="btn-primary flex-[2]"
            onClick={guardar}
            disabled={guardando || !name.trim()}
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
