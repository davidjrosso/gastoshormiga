import bcrypt from 'bcryptjs';
import { eq, lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import { db } from './db/index.js';
import { sessions, users, type User } from './db/schema.js';

export const COOKIE_NAME = 'hormiga_session';

/**
 * Sesiones largas a propósito: 90 días.
 * Esta app compite contra "anoto el gasto después" — y siempre gana el después.
 * Si te pide login cada semana en el celular, dejás de cargar los gastos
 * chicos, y los gastos chicos son justamente los que queremos ver.
 */
const SESSION_DAYS = 90;

/**
 * Alcance de la cookie de sesión.
 *
 * Esto importa porque en el VPS hormiga comparte ORIGEN con otra aplicación:
 * las dos viven en el mismo host, una en / y la otra en /hormiga/.
 * El navegador decide a quién manda una cookie según su `path`, así que con
 * el valor por defecto '/' le estaría mandando la sesión de hormiga a la otra
 * app en cada request. Acotándola a /hormiga, nunca sale de acá.
 *
 * Es el precio de no tener un dominio propio: sin separación de origen, la
 * separación hay que hacerla a mano.
 */
const COOKIE_PATH = process.env.COOKIE_PATH || '/';

export type AppEnv = {
  Variables: {
    user: User;
  };
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function createSession(c: Context, userId: string): string {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  db.insert(sessions).values({ id: token, userId, expiresAt }).run();

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: COOKIE_PATH,
    maxAge: SESSION_DAYS * 86_400,
    // En producción detrás de HTTPS querés secure:true. Se activa por env
    // para no romper el desarrollo local en http://localhost.
    secure: process.env.NODE_ENV === 'production',
  });

  return token;
}

export function destroySession(c: Context): void {
  const token = getCookie(c, COOKIE_NAME);
  if (token) db.delete(sessions).where(eq(sessions.id, token)).run();
  deleteCookie(c, COOKIE_NAME, { path: COOKIE_PATH });
}

export function getUserFromRequest(c: Context): User | null {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;

  const rows = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, token))
    .limit(1)
    .all();

  if (rows.length === 0) return null;

  const { session, user } = rows[0];
  if (session.expiresAt.getTime() < Date.now()) {
    db.delete(sessions).where(eq(sessions.id, token)).run();
    return null;
  }

  return user;
}

/** Corta el paso a cualquier ruta que no tenga sesión válida. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = getUserFromRequest(c);
  if (!user) return c.json({ error: 'No autenticado' }, 401);
  c.set('user', user);
  await next();
};

/** Limpia sesiones vencidas. Barato y evita que la tabla crezca para siempre. */
export function purgeExpiredSessions(): void {
  db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
}
