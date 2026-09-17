import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createSession, destroySession, hashPassword, requireAuth, verifyPassword, type AppEnv } from '../auth.js';
import { db } from '../db/index.js';
import { households, users } from '../db/schema.js';
import { seedHouseholdDefaults } from '../db/seed.js';

export const authRoutes = new Hono<AppEnv>();

const registerSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña necesita al menos 8 caracteres'),
  displayName: z.string().min(1, 'Falta el nombre'),
  householdName: z.string().min(1).optional(),
  /** Para que tu pareja entre al MISMO hogar en vez de crear uno nuevo. */
  inviteCode: z.string().uuid().optional(),
  /** Requerido solo si el server define REGISTRATION_CODE. */
  registrationCode: z.string().optional(),
});

authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0].message }, 400);
  }
  const { email, password, displayName, householdName, inviteCode, registrationCode } = parsed.data;

  // Si el server está expuesto a internet, esto es lo único que impide que
  // un desconocido se cree una cuenta en TU instancia. Ver README.
  const required = process.env.REGISTRATION_CODE;
  if (required && registrationCode !== required) {
    return c.json({ error: 'Código de registro incorrecto' }, 403);
  }

  const existing = db.select().from(users).where(eq(users.email, email)).limit(1).all();
  if (existing.length > 0) {
    return c.json({ error: 'Ya hay una cuenta con ese email' }, 409);
  }

  let householdId: string;

  if (inviteCode) {
    const found = db.select().from(households).where(eq(households.id, inviteCode)).limit(1).all();
    if (found.length === 0) return c.json({ error: 'Código de invitación inválido' }, 404);
    householdId = found[0].id;
  } else {
    const created = db
      .insert(households)
      .values({ name: householdName ?? `Casa de ${displayName}` })
      .returning()
      .all();
    householdId = created[0].id;
    seedHouseholdDefaults(householdId);
  }

  const passwordHash = await hashPassword(password);
  const user = db
    .insert(users)
    .values({ householdId, email, passwordHash, displayName })
    .returning()
    .all()[0];

  createSession(c, user.id);

  return c.json({
    user: { id: user.id, email: user.email, displayName: user.displayName, householdId },
  }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'Email o contraseña inválidos' }, 400);

  const found = db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1).all();
  // Mismo mensaje para "no existe" y "contraseña mal": no le confirmamos a
  // nadie qué emails tienen cuenta en esta instancia.
  const genericError = c.json({ error: 'Email o contraseña incorrectos' }, 401);
  if (found.length === 0) return genericError;

  const ok = await verifyPassword(parsed.data.password, found[0].passwordHash);
  if (!ok) return genericError;

  createSession(c, found[0].id);
  return c.json({
    user: {
      id: found[0].id,
      email: found[0].email,
      displayName: found[0].displayName,
      householdId: found[0].householdId,
    },
  });
});

authRoutes.post('/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (c) => {
  const user = c.get('user');
  const household = db
    .select()
    .from(households)
    .where(eq(households.id, user.householdId))
    .limit(1)
    .all()[0];

  const members = db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.householdId, user.householdId))
    .all();

  return c.json({
    user: { id: user.id, email: user.email, displayName: user.displayName },
    household: {
      id: household.id,
      name: household.name,
      baseCurrency: household.baseCurrency,
      fxRateType: household.fxRateType,
      // El id del hogar ES el código de invitación. Es un UUID, no se adivina.
      inviteCode: household.id,
    },
    members,
  });
});
