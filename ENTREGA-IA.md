# Hormiga 0.7.1: preparación de comparación VEA / Mercado Libre

Base: feat/comparar-ml d462e88 (0.7.0). Correcciones en codex/revision-comparar-ml.
David confirmó que la aplicación de ML ya está creada. Callback existente sslip.io identificado. Configuración privada preparada localmente;
pendientes transferencia autorizada y certificado TLS válido para ese hostname. No se desplegó esta versión.

Comparación: VEA conserva descuentos y recotiza el subconjunto mixto. La caché mantiene
su fecha de vencimiento original. ML conserva resultados parciales, limita concurrencia
y plazo, valida cantidades agregadas e informa envío/stock final a confirmar en checkout.
La selección por subtotal no garantiza equivalencia de presentaciones ni ahorro final.

OAuth: desconectar cancela estados pendientes/en curso. Refresh atrasado no recrea ni
reemplaza una cuenta nueva. Tokens cifrados con AES-256-GCM. Requiere callback HTTPS válido.
Detalles técnicos, configuración, API y límites: docs/ML.md y server/.env.example.

Server/web/lockfiles0.7.1; esquema aditivo v8. No cambia tablas financieras ni shopping_items.
Comprado solo tacha; “En qué se fue” conserva monto descendente y selectores A-Z.
Sin dependencias nuevas. Producción según último registro:0.6.0 /2cfd1f8 /esquema7.

Pruebas de regresión cubren OAuth concurrente, totales/promociones, centavos agrupados,
caché, cantidades repetidas, aislamiento y fallos parciales, sin credenciales ni red real.
Antes de desplegar repetir checks Linux y migración sobre copia consistente de PROD.
Falta QA OAuth y checkout real en PC/Android. No confirmar compras durante QA.
Seguir autorización y procedimiento privado, reiniciar solo Hormiga y comprobar Ticketera.

Validación local final (29/09/2026): 133 pruebas server +4 web, typecheck server,
builds server/web (APP_BASE=hormiga) y git diff --check correctos. No hubo consultas
nuevas a ML con credenciales reales ni modificaciones en producción en esta preparación.
