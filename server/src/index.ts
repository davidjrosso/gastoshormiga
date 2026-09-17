import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { purgeExpiredSessions, type AppEnv } from './auth.js';
import { DB_PATH } from './db/index.js';
import { startRateScheduler } from './fx/rates.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { recurringRoutes } from './routes/recurring.js';
import { transactionRoutes } from './routes/transactions.js';

const PORT = Number(process.env.PORT ?? 3001);
const isProd = process.env.NODE_ENV === 'production';

const app = new Hono<AppEnv>();

// En desarrollo el front corre en Vite (5173) y la API acá (3001), así que
// son orígenes distintos y hacen falta CORS con credenciales para la cookie.
// En producción el mismo proceso sirve las dos cosas y esto sobra.
if (!isProd) {
  app.use(
    '/api/*',
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
    }),
  );
}

app.get('/api/health', (c) =>
  c.json({ ok: true, db: DB_PATH, env: isProd ? 'production' : 'development' }),
);

app.route('/api/auth', authRoutes);
app.route('/api/transactions', transactionRoutes);
app.route('/api/recurring', recurringRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api', dataRoutes);

app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ error: 'Error interno del servidor' }, 500);
});

// --- Front compilado (solo producción) -------------------------------------

const WEB_DIST = resolve(process.cwd(), '..', 'web', 'dist');

if (isProd && existsSync(WEB_DIST)) {
  // Sirve cualquier archivo que exista en web/dist, sin enumerarlos.
  //
  // Enumerarlos a mano (assets, icons, sw.js, manifest...) parece más
  // explícito pero es una trampa: alcanza con que el build genere un archivo
  // nuevo para que quede fuera de la lista, caiga en el fallback de la SPA y
  // el navegador reciba HTML donde esperaba JavaScript. Pasó exactamente eso
  // con `registerSW.js`, y el síntoma era mudo: la PWA simplemente no se
  // registraba, sin ningún error del lado del servidor.
  //
  // Si el archivo no existe, serveStatic sigue de largo y cae en el fallback
  // de abajo. Las rutas /api ya quedaron resueltas antes de llegar acá.
  app.use('/*', serveStatic({ root: '../web/dist' }));

  // Cualquier otra ruta devuelve el index: es una SPA, el ruteo lo hace React.
  // Sin esto, recargar estando en /gastos tira 404.
  const indexHtml = readFileSync(resolve(WEB_DIST, 'index.html'), 'utf-8');
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'No encontrado' }, 404);
    return c.html(indexHtml);
  });
}

purgeExpiredSessions();
startRateScheduler();

// Por defecto solo escucha en loopback: en el VPS quien habla con internet es
// nginx, y este proceso no tiene por qué ser alcanzable directamente. Si el
// firewall alguna vez se cae o se reconfigura mal, la app no queda expuesta
// sin TLS. Se puede abrir con HOST=0.0.0.0 si algún día hace falta.
const HOST = process.env.HOST ?? '127.0.0.1';

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`\n  hormiga · servidor en http://${HOST}:${info.port}`);
  console.log(`  base de datos: ${DB_PATH}`);
  if (!isProd) console.log(`  front en desarrollo: http://localhost:5173\n`);
});
