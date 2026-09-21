import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Dónde vive la app dentro del dominio.
 *
 * En desarrollo es la raíz. En el VPS convive con otra app en la misma IP,
 * así que va colgada de /hormiga/. Se pasa por variable de entorno para que
 * el código no quede casado con una ruta concreta:
 *
 *   APP_BASE=hormiga npm run build
 *
 * Se normaliza acá adentro a propósito: aceptamos 'hormiga', '/hormiga' o
 * '/hormiga/' y siempre sale '/hormiga/'. Además de ser más cómodo, evita
 * que Git Bash en Windows convierta un valor que empieza con barra en una
 * ruta de Windows ('/hormiga/' -> 'C:/Program Files/Git/hormiga/'), que es
 * un error silencioso y desconcertante.
 */
const APP_BASE = (() => {
  const raw = (process.env.APP_BASE ?? '/').trim();
  const limpio = raw.replace(/^[A-Za-z]:/, '').replace(/^\/+|\/+$/g, '');
  return limpio ? `/${limpio}/` : '/';
})();

export default defineConfig({
  base: APP_BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        // start_url y scope tienen que apuntar al subdirectorio, o Android
        // instala la PWA apuntando a la raíz del server, donde vive otra app.
        start_url: APP_BASE,
        scope: APP_BASE,
        name: 'hormiga · economía de casa',
        short_name: 'hormiga',
        description: 'Control de gastos del hogar, con detección de gasto hormiga y ahorro en dólares.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        lang: 'es-AR',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // La app tiene que abrir sin conexión y mostrar lo último que vio.
        // Las llamadas a la API van a red primero: datos viejos en una app de
        // plata es peor que un error honesto.
        navigateFallback: `${APP_BASE}index.html`,
        // pdf.js queda fuera del precache a propósito.
        //
        // Solo lo necesita la pantalla de importar un resumen, que se usa una
        // vez por mes. Precacheándolo, el peso de instalar la PWA subía de
        // 611 kB a 980 kB para TODOS: se pagaría en cada instalación y en cada
        // actualización del service worker, por una función ocasional.
        //
        // Se baja la primera vez que entrás a importar y de ahí en más queda
        // en caché de runtime.
        globIgnores: ['**/pdf*.js', '**/pdf*.mjs'],
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            // pdf.js y su worker: una vez bajados, quedan. Son inmutables
            // (el nombre lleva hash), así que CacheFirst es lo correcto.
            urlPattern: /\/assets\/pdf.*\.(js|mjs)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
