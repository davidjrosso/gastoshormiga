import {
  ShoppingCart, Utensils, Coffee, Bike, Bus, Fuel, House, Building, Lightbulb,
  Wifi, HeartPulse, Pill, Clapperboard, Shirt, GraduationCap, PawPrint, Gift,
  Wrench, Tv, ShieldCheck, ReceiptText, BriefcaseBusiness, Laptop, Tags,
  Carrot, Plane, BookOpen, Ellipsis, UserRound, Dumbbell, Beef, CupSoda,
  Wallet, IceCreamCone, HandCoins,
} from 'lucide-react';

export const categoryIcons = [
  ['shopping-cart', 'Supermercado compras carrito', ShoppingCart], ['utensils', 'Comer afuera restaurante', Utensils],
  ['coffee', 'Café kiosco', Coffee], ['bike', 'Delivery bicicleta', Bike], ['bus', 'Transporte colectivo', Bus],
  ['fuel', 'Nafta combustible', Fuel], ['house', 'Alquiler casa', House], ['building', 'Edificio expensas', Building],
  ['lightbulb', 'Luz gas agua servicios', Lightbulb], ['wifi', 'Internet celular', Wifi], ['heart-pulse', 'Prepaga salud', HeartPulse],
  ['pill', 'Farmacia medicamentos', Pill], ['clapperboard', 'Salidas cine', Clapperboard], ['shirt', 'Ropa', Shirt],
  ['graduation-cap', 'Educación estudios', GraduationCap], ['paw-print', 'Mascotas animales', PawPrint], ['gift', 'Regalos', Gift],
  ['wrench', 'Hogar arreglos', Wrench], ['tv', 'Suscripciones televisión', Tv], ['shield-check', 'Seguros', ShieldCheck],
  ['receipt-text', 'Impuestos boleta', ReceiptText], ['briefcase-business', 'Sueldo trabajo', BriefcaseBusiness],
  ['laptop', 'Freelance computadora', Laptop], ['tags', 'Ventas', Tags], ['carrot', 'Almacén verdulería verduras', Carrot],
  ['plane', 'Viajes vacaciones', Plane], ['book-open', 'Libros', BookOpen], ['ellipsis', 'Otros', Ellipsis],
  ['user-round', 'Persona hijo hija familia', UserRound], ['dumbbell', 'Actividades físicas gimnasio', Dumbbell],
  ['beef', 'Asados juntadas carne', Beef], ['cup-soda', 'Bebidas', CupSoda], ['wallet', 'Gastos extra billetera', Wallet],
  ['ice-cream-cone', 'Helados', IceCreamCone], ['hand-coins', 'Otros ingresos', HandCoins],
] as const;

const legacy: Record<string, string> = { '🛒':'shopping-cart','🍽️':'utensils','☕':'coffee','🛵':'bike','🚌':'bus','⛽':'fuel','🏠':'house','🏢':'building','💡':'lightbulb','📶':'wifi','⚕️':'heart-pulse','💊':'pill','🎬':'clapperboard','👕':'shirt','🎓':'graduation-cap','🐾':'paw-print','🎁':'gift','🔧':'wrench','📺':'tv','🛡️':'shield-check','📄':'receipt-text','💼':'briefcase-business','💻':'laptop','🏷️':'tags','🥬':'carrot','✈️':'plane','📚':'book-open','🧾':'receipt-text' };
const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function categoryIconId(icon?: string | null, name = ''): string {
  if (icon?.startsWith('lucide:') && categoryIcons.some(([id]) => id === icon.slice(7))) return icon.slice(7);
  const n = normalized(name);
  if (/^hij[oa]\b/.test(n)) return 'user-round';
  const match: Array<[RegExp, string]> = [[/^actividades fisicas/,'dumbbell'],[/^asados/,'beef'],[/^bebidas/,'cup-soda'],[/^gastos extra/,'wallet'],[/^helados/,'ice-cream-cone'],[/^otros ingresos/,'hand-coins'],[/^hogar$/,'wrench']];
  const named = match.find(([pattern]) => pattern.test(n));
  const names: Record<string, string> = { 'almacen y verduleria':'carrot', 'alquiler':'house', 'cafe y kiosco':'coffee', 'comer afuera':'utensils', 'delivery':'bike', 'educacion':'graduation-cap', 'impuestos':'receipt-text', 'internet y celular':'wifi', 'luz, gas y agua':'lightbulb', 'mascotas':'paw-print', 'nafta':'fuel', 'otros':'ellipsis', 'prepaga':'heart-pulse', 'regalos':'gift', 'ropa':'shirt', 'salidas':'clapperboard', 'salud y farmacia':'pill', 'seguros':'shield-check', 'supermercado':'shopping-cart', 'suscripciones':'tv', 'transporte':'bus', 'freelance':'laptop', 'sueldo':'briefcase-business', 'ventas':'tags' };
  return named?.[1] ?? names[n] ?? legacy[icon ?? ''] ?? 'ellipsis';
}

export default function CategoryIcon({ icon, name, size = 18, color }: { icon?: string | null; name?: string | null; size?: number; color?: string }) {
  const id = categoryIconId(icon, name ?? '');
  const Icon = categoryIcons.find(([key]) => key === id)?.[2] ?? Ellipsis;
  const initial = id === 'user-round' ? name?.trim().split(/\s+/).at(-1)?.slice(0, 1).toUpperCase() : null;
  return <span className="inline-flex shrink-0 items-center gap-0.5 align-middle" style={{ color }} aria-hidden="true"><Icon size={size} />{initial && <small className="text-[9px] font-bold">{initial}</small>}</span>;
}

export function IconPicker({ value, onChange, search, onSearch }: { value: string; onChange: (icon: string) => void; search: string; onSearch: (text: string) => void }) {
  const options = categoryIcons.filter(([, label]) => normalized(label).includes(normalized(search)));
  return <div><input className="input mb-2" aria-label="Buscar icono" placeholder="Buscar: salud, persona, compras…" value={search} onChange={e => onSearch(e.target.value)} /><div className="flex flex-wrap gap-1.5">{options.map(([id, label, Icon]) => <button type="button" key={id} title={label} aria-label={label} aria-pressed={value === `lucide:${id}`} onClick={() => onChange(`lucide:${id}`)} className={`flex h-11 w-11 items-center justify-center rounded-xl ${value === `lucide:${id}` ? 'bg-ant/20 ring-2 ring-ant' : 'bg-slate-100 dark:bg-slate-800'}`}><Icon size={22} /></button>)}</div>{!options.length && <p className="py-2 text-sm">No hay iconos con esa búsqueda.</p>}</div>;
}
