# Hormiga 0.7.0: comparar VEA y Mercado Libre

Implementación solicitada por David el 29/09/2026 (rama feat/comparar-ml).
Desde Compras, “Comparar VEA / ML” cotiza pendientes en VEA Río Tercero (retiro,
costo $0) y en Mercado Libre solo con ofertas Full, para un único envío. Muestra
Todo VEA, Todo ML (envío orientativo de un paquete) y Mixto, y abre los carritos.
Ajustes permite conectar la cuenta de ML (OAuth PKCE) por callback o pegando la URL.

Sin efectos sobre gastos, precios históricos ni shopping_items. La cotización es
efímera (2 minutos). “En qué se fue” sigue por monto descendente; selectores alfabéticos.

0.7.0 en server/web y lockfiles; migración aditiva v8: store_accounts y
store_oauth_pending. Sin dependencias nuevas. Binarios <=0.6.0 rechazan v8.
Tokens cifrados AES-256-GCM con HORMIGA_TOKEN_KEY. Variables, API y límites: docs/ML.md.
El cotizador VEA 0.6.0 se refactorizó para compartir la carga de pendientes; mismas pruebas.

Pruebas server (incluye 12 nuevas de ML/comparación, sin red), 4 cliente,
typecheck y builds APP_BASE=hormiga correctos. Endpoints ML verificados con la cuenta
de David antes de programar; el carrito ML usa un enlace no documentado por ML.
Pendiente: QA en producción (conectar, comparar, abrir carritos en PC y Android).

NO desplegado. Estado previo conocido: 0.6.0 / 2cfd1f8 / esquema v7.
Antes de desplegar: autorización, estado real/commit, backup consistente y checksum,
migración en copia, builds Linux, código/assets previos, variables ML y clave de tokens
en el entorno. Reiniciar solo Hormiga, comprobar Ticketera y registrar evidencia privada.
Nunca reemplazar PROD por DEV.
