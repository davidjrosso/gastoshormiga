import { useCallback } from 'react';
import { useAuth } from '../App';

export interface MlStatus { configured: boolean; connected: boolean; connectedBy: string | null; connectedAt: number | null }
export interface MlOfferSummary { itemId: string; unitMinor: number; freeShipping: boolean; shippingMinor: number | null; eta: string | null }
export interface MlProduct { productId: string; productName: string; gtin: string; offer: MlOfferSummary | null; reason: string | null }
export interface CompareVea { productName: string; available: boolean; unitMinor: number | null; subtotalMinor: number | null; reason: string | null }
export interface CompareMl { productId: string; productName: string; itemId: string | null; unitMinor: number | null; subtotalMinor: number | null; qty: number; shippingMinor: number | null; freeShipping: boolean; eta: string | null; reason: string | null }
export interface CompareRow { itemId: string; name: string; qty: number; vea: CompareVea | null; ml: CompareMl | null }
export interface Comparison {
  rows: CompareRow[];
  summary: {
    choices: Record<string, 'vea' | 'ml' | null>;
    vea: { productsMinor: number; totalMinor: number; missing: number };
    ml: { productsMinor: number; shippingMinor: number | null; totalMinor: number | null; missing: number };
    mixed: { productsMinor: number | null; shippingMinor: number | null; totalMinor: number | null; veaCount: number; mlCount: number; missing: number };
  };
  quotedAt: number; expiresAt: number; mixedError: string | null; veaError: string | null; mlError: string | null; mlReconnect: boolean;
  carts: { vea: string | null; ml: string | null; mixedVea: string | null; mixedMl: string | null };
}

/** Llamadas a /api/shopping/* con la sesión y los encabezados de hogar/usuario de Compras. */
export function useShoppingApi(label: string) {
  const { me } = useAuth();
  const household = me?.household.id; const user = me?.user.id;
  return useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (!household || !user) throw new Error(`Volvé a ingresar para consultar ${label}.`);
    if (!navigator.onLine) throw new Error(`Necesitás conexión para consultar ${label}.`);
    let response: Response;
    try {
      response = await fetch(`${import.meta.env.BASE_URL}api/shopping${path}`, {
        method, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(45_000),
        headers: { 'Content-Type': 'application/json', 'X-Hormiga-Household': household, 'X-Hormiga-User': user },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error(`No se pudo conectar con ${label}. Probá nuevamente.`); }
    const data = await response.json().catch(() => ({ error: 'Respuesta no disponible. Probá nuevamente.' }));
    if (!response.ok) throw new Error(data.error ?? `No se pudo consultar ${label}.`);
    return data as T;
  }, [household, user, label]);
}
