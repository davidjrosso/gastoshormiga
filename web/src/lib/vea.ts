import { useCallback } from 'react';
import { useAuth } from '../App';
export { initialVeaQuantity } from './vea-quantity';
export interface VeaSettings { salesChannel: string; sellerId: string; label: string; saved: boolean }
export interface VeaOffer { sku: string; qty: number; available: boolean; unitMinor: number | null; subtotalMinor: number | null; pickup: string | null; reason: string | null }
export interface VeaProduct { sku: string; ean: string; productName: string; supported: boolean; offer: VeaOffer | null }
export interface VeaQuote {
  rows: Array<{ itemId: string; itemKey: string; name: string; qty: number; link: { sku: string; productName: string; packQty: number } | null }>;
  offers: VeaOffer[]; totalMinor: number; quotedAt: number; expiresAt: number; cartUrl: string | null; settings: VeaSettings;
}
export function useVeaApi() {
  const { me } = useAuth();
  const household = me?.household.id; const user = me?.user.id;
  return useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (!household || !user) throw new Error('Volvé a ingresar para consultar VEA.');
    if (!navigator.onLine) throw new Error('Necesitás conexión para consultar VEA.');
    let response: Response;
    try {
      response = await fetch(`${import.meta.env.BASE_URL}api/shopping/stores/vea${path}`, {
        method, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(25_000),
        headers: { 'Content-Type': 'application/json', 'X-Hormiga-Household': household, 'X-Hormiga-User': user },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error('No se pudo conectar con VEA. Probá nuevamente.'); }
    const data = await response.json().catch(() => ({ error: 'Respuesta no disponible. Probá nuevamente.' }));
    if (!response.ok) throw new Error(data.error ?? 'No se pudo consultar VEA.');
    return data as T;
  }, [household, user]);
}
