import { ApiError } from './api';
import type {
  StatementDocument,
  StatementRecord,
  Settlement,
  summarize,
} from '../../../server/src/statements/model';
export type {
  StatementDocument,
  StatementRecord,
  Settlement,
  LedgerLine,
  Currency,
} from '../../../server/src/statements/model';
export { summarize, holderKey, proportionalAllocation } from '../../../server/src/statements/model';
const base = `${import.meta.env.BASE_URL}api/statements`.replace(/\/{2,}/g, '/');
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...options,
    credentials: 'include',
    cache: 'no-store',
    headers:
      options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : undefined,
  });
  const data = await response.json().catch(() => ({ error: 'Respuesta invalida del servidor.' }));
  if (!response.ok)
    throw new ApiError(data.error ?? 'No se pudo completar la operacion.', response.status);
  return data;
}
export interface StatementListItem {
  id: string;
  status: string;
  closeDate: string;
  sourceName: string;
  summary: ReturnType<typeof summarize>;
}
export const statements = {
  movementSettings: () => request<{ users: { id: string; name: string }[]; mappings: { holder: string; userId: string | null }[] }>('/movement-settings'),
  configureMovements: (id: string, mappings: { holder: string; userId: string | null }[]) =>
    request<{ created: number; linked: number; deferred: boolean }>(`/${id}/movements`, { method: 'POST', body: JSON.stringify(mappings) }),
  list: () => request<StatementListItem[]>(''),
  get: (id: string) => request<StatementRecord>(`/${id}`),
  analyze: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<{ record: StatementRecord; text: string; duplicate: boolean }>('/analyze', {
      method: 'POST',
      body: form,
    });
  },
  parse: (text: string) =>
    request<StatementDocument>('/parse', { method: 'POST', body: JSON.stringify({ text }) }),
  save: (record: StatementRecord, confirm: boolean) =>
    request<StatementRecord>(`/${record.id}`, {
      method: 'PUT',
      body: JSON.stringify({ revision: record.revision, document: record.document, confirm }),
    }),
  settle: (id: string, entry: Settlement) =>
    request<StatementRecord>(`/${id}/settlements`, { method: 'POST', body: JSON.stringify(entry) }),
  removeSettlement: (id: string, entry: string) =>
    request<StatementRecord>(`/${id}/settlements/${entry}`, { method: 'DELETE' }),
};
export const money = (minor: number, currency = 'ARS') =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency, minimumFractionDigits: 2 }).format(
    minor / 100,
  );
