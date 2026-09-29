import { sqlite } from '../db/index.js';
import { loadKey, open, seal, SecretBoxError } from '../lib/secret-box.js';
import { authUrl, MlAuthError, MlClient, MlError, newPkce, type MlTokens } from './ml.js';

const PENDING_TTL = 10 * 60_000;
const REFRESH_MARGIN = 5 * 60_000;
type AccountRow = { household_id: string; user_id: string; external_user_id: string; access_token_enc: string; refresh_token_enc: string; expires_at: number; scope: string; updated_at: number };
type PendingRow = { state: string; household_id: string; user_id: string; code_verifier_enc: string; created_at: number };
const ctx = (household: string, kind: string) => `ml:${household}:${kind}`;

/**
 * Cuenta de Mercado Libre del hogar: tokens cifrados, refresco y OAuth con PKCE.
 * La cuenta la conecta una persona, pero la comparación la puede usar el hogar:
 * solo se consultan catálogo, ofertas y costos de envío, nunca datos de la cuenta.
 */
export class MlAccounts {
  private generations = new Map<string, number>();
  private invalidate(household: string) { this.generations.set(household, (this.generations.get(household) ?? 0) + 1); }
  private refreshing = new Map<string, Promise<string>>();
  constructor(readonly client: MlClient, private key: Buffer | null = loadKey()) {}
  get configured(): boolean { return !!this.client.config && !!this.key; }
  private requireKey(): Buffer {
    if (!this.client.config || !this.key) throw new MlError('Mercado Libre no está configurado en el servidor.');
    return this.key;
  }
  status(household: string) {
    const row = sqlite.prepare("SELECT a.user_id, a.updated_at, u.display_name FROM store_accounts a JOIN users u ON u.id=a.user_id WHERE a.household_id=? AND a.store='ml'").get(household) as { user_id: string; updated_at: number; display_name: string } | undefined;
    return { configured: this.configured, connected: !!row, connectedBy: row?.display_name ?? null, connectedAt: row?.updated_at ?? null };
  }
  startConnect(household: string, userId: string): string {
    const key = this.requireKey();
    const { verifier, challenge, state } = newPkce();
    const now = Date.now();
    this.invalidate(household);
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM store_oauth_pending WHERE store='ml' AND (created_at < ? OR household_id=?)").run(now - PENDING_TTL, household);
      sqlite.prepare('INSERT INTO store_oauth_pending VALUES(?,?,?,?,?,?)').run(state, 'ml', household, userId, seal(verifier, key, `ml:${state}:verifier`), now);
    })();
    return authUrl(this.client.config!, state, challenge);
  }
  /** Consume el state (un solo uso). `expected` se usa cuando la vuelta se pega desde una sesión. */
  async complete(state: string, code: string, expected?: { household: string; user: string }): Promise<{ household: string }> {
    const key = this.requireKey();
    const pending = sqlite.transaction(() => {
      const row = sqlite.prepare("SELECT * FROM store_oauth_pending WHERE state=? AND store='ml'").get(state) as PendingRow | undefined;
      if (row && expected && (row.household_id !== expected.household || row.user_id !== expected.user)) throw new MlAuthError('Esta autorización la inició otra sesión.');
      if (row) sqlite.prepare('DELETE FROM store_oauth_pending WHERE state=?').run(state);
      return row;
    }).immediate();
    if (!pending || Date.now() - pending.created_at > PENDING_TTL) throw new MlAuthError('La autorización venció o ya se usó. Volvé a conectar Mercado Libre.');
    if (expected && (pending.household_id !== expected.household || pending.user_id !== expected.user)) throw new MlAuthError('Esta autorización la inició otra sesión. Volvé a conectar desde acá.');
    let verifier: string;
    try { verifier = open(pending.code_verifier_enc, key, `ml:${state}:verifier`); } catch { throw new MlAuthError('No se pudo validar la autorización. Volvé a conectar.'); }
    const generation = this.generations.get(pending.household_id) ?? 0;
    const tokens = await this.client.exchangeCode(code, verifier);
    if (generation !== (this.generations.get(pending.household_id) ?? 0)) throw new MlAuthError('La conexión se canceló o fue reemplazada. Volvé a conectar.');
    this.save(pending.household_id, pending.user_id, tokens);
    return { household: pending.household_id };
  }
  private save(household: string, userId: string, t: MlTokens) {
    const key = this.requireKey();
    sqlite.prepare(`INSERT INTO store_accounts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(household_id,store) DO UPDATE SET
      user_id=excluded.user_id, external_user_id=excluded.external_user_id, access_token_enc=excluded.access_token_enc,
      refresh_token_enc=excluded.refresh_token_enc, expires_at=excluded.expires_at, scope=excluded.scope, updated_at=excluded.updated_at`)
      .run(household, 'ml', userId, t.externalUserId, seal(t.accessToken, key, ctx(household, 'access')), seal(t.refreshToken, key, ctx(household, 'refresh')), t.expiresAt, t.scope, Date.now());
  }
  disconnect(household: string) {
    this.invalidate(household);
    sqlite.prepare("DELETE FROM store_oauth_pending WHERE household_id=? AND store='ml'").run(household);
    sqlite.prepare("DELETE FROM store_accounts WHERE household_id=? AND store='ml'").run(household);
    this.refreshing.delete(household);
  }
  /** Token vigente del hogar; refresca una sola vez aunque haya consultas simultáneas. */
  async accessToken(household: string): Promise<string> {
    const key = this.requireKey();
    const row = sqlite.prepare("SELECT * FROM store_accounts WHERE household_id=? AND store='ml'").get(household) as AccountRow | undefined;
    if (!row) throw new MlAuthError('Conectá tu cuenta de Mercado Libre en Ajustes para comparar.');
    try {
      if (row.expires_at - REFRESH_MARGIN > Date.now()) return open(row.access_token_enc, key, ctx(household, 'access'));
      const running = this.refreshing.get(household);
      if (running) return await running;
      const unchanged = () => (sqlite.prepare("SELECT refresh_token_enc FROM store_accounts WHERE household_id=? AND store='ml'").get(household) as { refresh_token_enc: string } | undefined)?.refresh_token_enc === row.refresh_token_enc;
      const refresh = (async () => {
        let tokens: MlTokens;
        try { tokens = await this.client.refresh(open(row.refresh_token_enc, key, ctx(household, 'refresh'))); }
        catch (e) { if (e instanceof MlAuthError && unchanged()) this.disconnect(household); throw e; }
        if (!unchanged()) throw new MlAuthError('La conexión cambió durante la consulta. Volvé a consultar.');
        this.save(household, row.user_id, tokens);
        return tokens.accessToken;
      })();
      this.refreshing.set(household, refresh);
      try { return await refresh; } finally { if (this.refreshing.get(household) === refresh) this.refreshing.delete(household); }
    } catch (e) {
      if (e instanceof SecretBoxError) { this.disconnect(household); throw new MlAuthError('La conexión guardada no es válida en este servidor. Volvé a conectar Mercado Libre.'); }
      throw e;
    }
  }
}
