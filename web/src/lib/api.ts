/**
 * Cliente de la API.
 *
 * `credentials: 'include'` en todas: la sesión va en una cookie httpOnly,
 * así que el token nunca queda expuesto a JavaScript. En desarrollo el proxy
 * de Vite manda /api al server en :3001; en producción es el mismo origen.
 */

/**
 * `import.meta.env.BASE_URL` lo inyecta Vite desde la opción `base`: vale '/'
 * en desarrollo y '/hormiga/' en el VPS. Así las llamadas salen a la ruta
 * correcta sin condicionales ni variables duplicadas.
 *
 * nginx recorta el prefijo antes de pasarle la request al backend, o sea que
 * el servidor sigue viendo '/api/...' y no necesita enterarse de nada.
 */
const BASE = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, '/');

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Error de conexión' }));
    throw new ApiError(body.error ?? `Error ${res.status}`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

// --- Tipos -----------------------------------------------------------------

export interface Me {
  user: { id: string; email: string; displayName: string };
  household: {
    id: string;
    name: string;
    baseCurrency: string;
    fxRateType: string;
    inviteCode: string;
  };
  members: Array<{ id: string; displayName: string; email: string }>;
}

export interface Account {
  accountId: string;
  name: string;
  type: string;
  currency: string;
  balanceMinor: number;
}

export interface Category {
  id: string;
  name: string;
  kind: 'gasto' | 'ingreso';
  isFixed: boolean;
  color: string;
  icon: string;
  archived: boolean;
}

export interface Transaction {
  statementId?: string | null;
  id: string;
  type: 'gasto' | 'ingreso' | 'transferencia';
  date: string;
  amountMinor: number;
  currency: string;
  amountToMinor: number | null;
  currencyTo: string | null;
  note: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  merchantName: string | null;
  accountName: string | null;
  paidByUserId: string | null;
}

/** Lo que la pantalla de edición puede cambiar. El tipo y la cuenta no
 *  se tocan: ver el comentario del PATCH en el server. */
export interface TransactionEdit {
  amount?: string;
  date?: string;
  categoryId?: string | null;
  merchantName?: string | null;
  note?: string | null;
  paidByUserId?: string | null;
}

export interface Summary {
  period: string;
  incomeMinor: number;
  expenseMinor: number;
  fixedExpenseMinor: number;
  variableExpenseMinor: number;
  balanceMinor: number;
  savingsRatePct: number | null;
  incomeUsdCents: number | null;
  expenseUsdCents: number | null;
  txCount: number;
}

export interface CategoryTrend {
  categoryId: string | null;
  categoryName: string;
  color: string;
  currentMinor: number;
  baselineMinor: number;
  changePct: number | null;
  shareOfIncomePct: number | null;
  baselineShareOfIncomePct: number | null;
}

export interface HormigaItem {
  merchantId: string | null;
  merchantName: string;
  categoryName: string | null;
  count: number;
  totalMinor: number;
  avgMinor: number;
  monthlyAvgMinor: number;
  annualizedMinor: number;
  annualizedUsdCents: number | null;
  timesPerMonth: number;
  firstDate: string;
  lastDate: string;
}

export interface SubscriptionItem {
  merchantId: string | null;
  merchantName: string;
  amountMinor: number;
  currency: string;
  cadence: 'mensual' | 'anual';
  occurrences: number;
  lastDate: string;
  nextExpectedDate: string;
  monthlyEquivalentMinor: number;
  annualMinor: number;
  priceChangePct: number | null;
  daysSinceLast: number;
  isDeclaredFixed: boolean;
}

export interface SavingsSummary {
  usdHeldCents: number;
  arsLiquidMinor: number;
  arsSpentBuyingUsdMinor: number;
  avgPurchaseRateMinor: number | null;
  currentRateMinor: number | null;
  usdValueInArsMinor: number | null;
  unrealizedArsMinor: number | null;
  unrealizedPct: number | null;
  netWorthArsMinor: number | null;
  netWorthUsdCents: number | null;
}

export interface FxRate {
  type: string;
  buyMinor: number;
  sellMinor: number;
  date: string;
}

export interface MemberSpend {
  userId: string | null;
  expenseMinor: number;
  incomeMinor: number;
  txCount: number;
}

export interface Dashboard {
  period: string;
  summary: Summary;
  previous: Summary;
  trends: CategoryTrend[];
  byMember: MemberSpend[];
  savings: SavingsSummary;
  usdBought: { usdCents: number; arsMinor: number };
  balances: Account[];
  rates: FxRate[];
}

export interface RecurringRule {
  id: string;
  description: string;
  amountMinor: number;
  currency: string;
  accountId: string;
  categoryId: string | null;
  dayOfMonth: number;
  active: boolean;
  lastGeneratedPeriod: string | null;
  /** Quién pone la plata para este fijo. Null = sale de la cuenta conjunta. */
  paidByUserId: string | null;
}

// --- Endpoints -------------------------------------------------------------

export const api = {
  me: () => get<Me>('/auth/me'),
  login: (email: string, password: string) =>
    post<{ user: Me['user'] }>('/auth/login', { email, password }),
  register: (data: {
    email: string;
    password: string;
    displayName: string;
    householdName?: string;
    inviteCode?: string;
    registrationCode?: string;
  }) => post<{ user: Me['user'] }>('/auth/register', data),
  logout: () => post<{ ok: true }>('/auth/logout'),

  dashboard: (period?: string) =>
    get<Dashboard>(`/analytics/dashboard${period ? `?period=${period}` : ''}`),
  history: (months = 6) => get<Summary[]>(`/analytics/history?months=${months}`),
  hormiga: (months = 3) => get<HormigaItem[]>(`/analytics/hormiga?months=${months}`),
  subscriptions: (months = 6) => get<SubscriptionItem[]>(`/analytics/subscriptions?months=${months}`),
  savings: () => get<SavingsSummary>('/analytics/savings'),
  refreshFx: () => post<FxRate[]>('/analytics/fx/refresh'),
  setFxManual: (data: { sell: string; buy?: string; type?: string; date?: string }) =>
    post<FxRate[]>('/analytics/fx/manual', data),

  accounts: () => get<Account[]>('/accounts'),
  createAccount: (data: { name: string; type: string; currency: string; openingBalance?: string }) =>
    post<unknown>('/accounts', data),
  categories: (includeArchived = false) =>
    get<Category[]>(`/categories${includeArchived ? '?includeArchived=1' : ''}`),
  createCategory: (data: {
    name: string;
    kind: 'gasto' | 'ingreso';
    isFixed: boolean;
    color: string;
    icon: string;
  }) => post<Category>('/categories', data),
  updateCategory: (id: string, data: Partial<Omit<Category, 'id'>>) =>
    patch<Category>(`/categories/${id}`, data),
  deleteCategory: (id: string) =>
    del<{ accion: 'archivada' | 'borrada' }>(`/categories/${id}`),

  merchants: () => get<Array<{ id: string; name: string }>>('/merchants'),

  transactions: (params: { period?: string; type?: string; limit?: number; paidBy?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.period) q.set('period', params.period);
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.paidBy) q.set('paidBy', params.paidBy);
    const qs = q.toString();
    return get<Transaction[]>(`/transactions${qs ? `?${qs}` : ''}`);
  },
  createTransaction: (data: Record<string, unknown>) => post<Transaction>('/transactions', data),
  updateTransaction: (id: string, data: TransactionEdit) =>
    patch<Transaction>(`/transactions/${id}`, data),
  deleteTransaction: (id: string) => del<{ ok: true }>(`/transactions/${id}`),

  recurring: () => get<RecurringRule[]>('/recurring'),
  createRecurring: (data: {
    description: string;
    amount: string;
    accountId: string;
    categoryId?: string | null;
    dayOfMonth: number;
    paidByUserId?: string | null;
  }) => post<RecurringRule>('/recurring', data),
  updateRecurring: (id: string, data: Record<string, unknown>) =>
    patch<RecurringRule>(`/recurring/${id}`, data),
  deleteRecurring: (id: string) => del<{ ok: true }>(`/recurring/${id}`),
  generateRecurring: () => post<{ created: number; period: string }>('/recurring/generate'),
};
