import type { Me } from './api';
const KEY = 'hormiga-offline-profile-v1';
// No password, cookie or session token is stored here.
export function rememberOfflineProfile(me: Me) {
  try { localStorage.setItem(KEY, JSON.stringify({ me: { ...me, household: { ...me.household, inviteCode: '' } }, savedAt: Date.now() })); } catch { /* Shopping shows storage failures separately. */ }
}
export function offlineProfile(): Me | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return saved?.me?.user?.id && saved?.me?.household?.id && Date.now() - saved.savedAt < 7 * 86400000 ? saved.me as Me : null;
  } catch { return null; }
}
export function forgetOfflineProfile() { try { localStorage.removeItem(KEY); } catch { /* Already unavailable. */ } }
