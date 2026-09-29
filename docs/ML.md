# Mercado Libre y comparación VEA/ML — Hormiga 0.7.0

Desde Compras, “Comparar VEA / ML” cotiza los pendientes elegidos en VEA Río Tercero
(retiro, sin costo) y en Mercado Libre **solo con ofertas Full**, para que todo lo de ML
llegue junto en un mismo envío. Muestra tres resúmenes y abre los carritos; la decisión y
el pago son de la persona, en cada tienda.

## Decisiones de David (29/09/2026)

- Retiro en VEA = $0: la sucursal está cerca; no hay ajuste de costo de retiro.
- Solo ofertas Full de ML, para un único envío.
- Envío ML orientativo: David tiene Meli+ y decide mirando el checkout. Hormiga no
  modela reglas de envío gratis.
- Certificado HTTPS actual: válido para la IP. ML no acepta IP como redirect (ver abajo).

## Comportamiento

- Hasta 30 pendientes por comparación, cantidades enteras 1–99 (mismo criterio que VEA).
- VEA usa el vínculo y la simulación de 0.6.0 (docs/VEA.md). Sin vínculo VEA, el producto
  se vincula desde “Cotizar en VEA”.
- ML: “Elegir en ML” busca en el catálogo y muestra la oferta Full más barata de cada ficha,
  con envío informado a 5850. El vínculo (nombre+marca → ficha `MLA…`) es del hogar y
  guarda el GTIN si ML lo informa.
- Por producto se elige la oferta Full nueva más barata del momento. Ofertas no Full,
  usadas o en otra moneda se ignoran. Sin oferta Full: “Sin ofertas Full”.
- Resúmenes:
  - **Todo VEA:** suma de subtotales disponibles en la sucursal.
  - **Todo ML:** productos + envío orientativo de un paquete = el mayor costo informado
    entre los productos (0 si todos figuran gratis; “no informado” si falta alguno).
  - **Mixto:** cada producto donde es más barato (empate → VEA). Si el ahorro en ML no
    cubre el envío informado, avisa que conviene todo VEA salvo envío gratis en el checkout.
- Faltantes por tienda: sin vínculo, sin stock/retiro (VEA) o sin oferta Full (ML).
- Carritos: VEA con el enlace de 0.6.0; ML con `gz/checkout/cart/buy?site_id=MLA&items=ID-Qn,…`.
  **Ese enlace de ML no está documentado por ML**: si deja de funcionar, la comparación
  sigue siendo válida y el carrito se arma a mano.
- Precios, totales y enlaces viven solo en memoria; vigencia 2 minutos. No registra
  precios, gastos ni cambia la lista. Si una tienda falla, la otra sigue respondiendo.

## Conexión de la cuenta (Ajustes → Mercado Libre)

OAuth con PKCE. Una persona conecta la cuenta para el hogar; la comparación solo consulta
catálogo, ofertas y costos de envío, nunca compras ni datos de la cuenta.

1. “Conectar Mercado Libre” abre la autorización en otra pestaña.
2. ML vuelve a `ML_REDIRECT_URI` (host sslip.io, porque ML bloquea redirects a una IP con
   403 de CloudFront). Como el certificado cubre la IP y no ese nombre, el navegador puede
   mostrar un aviso de certificado.
3. Dos formas de terminar:
   - **Callback del servidor** (`GET /api/ml/callback`): si nginx deriva el host sslip.io a
     Hormiga, el servidor completa la conexión y redirige a `ML_RETURN_URL?ml=conectado`.
   - **Pegar la dirección**: en Ajustes, pegar la URL de vuelta completa. No requiere tocar
     nginx ni el certificado.

Tokens: `store_accounts`, cifrados con AES-256-GCM (clave `HORMIGA_TOKEN_KEY`, contexto
por hogar como AAD). Se refrescan 5 minutos antes de vencer, una sola vez aunque haya
consultas simultáneas. Si ML rechaza el refresh o la clave cambió, se desconecta y se pide
reconectar. `state` de un solo uso, 10 minutos, ligado al hogar y a la persona que inició;
el verificador PKCE también va cifrado.

La app de ML (devcenter) recibió scopes de escritura además de lectura: ML fija
“Usuarios” en lectura/escritura. Riesgo aceptado; el código solo hace consultas GET.

## Variables de entorno (servidor)

| Variable | Uso |
| --- | --- |
| `ML_CLIENT_ID` | App ID de la app “Hormigar” |
| `ML_CLIENT_SECRET` | Clave secreta. Solo en el entorno del servidor. |
| `ML_REDIRECT_URI` | Idéntica a la cargada en ML: `https://<ip-con-guiones>.sslip.io/hormiga/api/ml/callback` |
| `ML_RETURN_URL` | Opcional, HTTPS: a dónde volver tras el callback, p. ej. `https://<IP>/hormiga/ajustes` |
| `ML_POSTAL_CODE` | Opcional, 4 dígitos. Por defecto 5850. |
| `HORMIGA_TOKEN_KEY` | 32 bytes en base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Sin cualquiera de ellas (salvo las opcionales), ML queda deshabilitado y VEA sigue igual.
Cambiar `HORMIGA_TOKEN_KEY` invalida la conexión guardada: hay que reconectar.

## API y migración

Bajo `/api/shopping`, con el middleware de Compras (sesión y X-Hormiga-Household /
X-Hormiga-User coincidentes, no-store, PWA NetworkOnly):

- `GET /stores/ml/status` · `POST /stores/ml/connect` → `{authUrl}` ·
  `POST /stores/ml/complete {url}` · `DELETE /stores/ml/connection`
- `GET /stores/ml/search?q=` → hasta 6 fichas con su mejor oferta Full y envío
- `PUT /stores/ml/links/:itemKey {itemId, productId}` · `DELETE /stores/ml/links/:itemKey`
- `POST /compare {items:[{itemId,qty}]}` → filas, resúmenes, errores por tienda, carritos

Pública: `GET /api/ml/callback?code&state` (sin sesión; valida `state`). El service worker
no intercepta navegaciones a `/api/`.

v8 agrega `store_accounts` y `store_oauth_pending`. No modifica tablas financieras,
Compras ni vínculos de v7. Binarios ≤0.6.0 rechazan v8. Sin dependencias nuevas.

Cliente en `server/src/stores/ml.ts`: dominio fijo, sin redirecciones, timeout 8 s, caché
acotada (catálogo 10 min, ofertas y envío 2 min, envío separado por hogar). Límites: 30
consultas/min y 2 simultáneas por hogar en ML; 20/min y 1 simultánea en /compare.

## Verificado con la cuenta de David (29/09/2026)

- `/sites/MLA/search`: 403 aun con token → no se usa. `/items/{id}`: 403 → no se usa.
- `/products/search`, `/products/{id}`, `/products/{id}/items`,
  `/items/{id}/shipping_options?zip_code=5850`: 200.
- Muchas fichas no tienen ofertas (p. ej. leche, papel higiénico): ML sirve más para
  almacén seco.
- Enlace de carrito con tres productos: funcionó en PC. Falta Android.

## Pendiente de QA manual

- Conectar desde Ajustes en producción (callback o pegar URL).
- Comparar 10 productos reales y abrir los carritos en PC y Android sin confirmar compras.
- Confirmar que el envío orientativo se parece al checkout con Meli+.

## Entrega

Server/web y lockfiles 0.7.0; esquema v8. Desplegar solo con autorización y el
procedimiento privado habitual, agregando las variables de entorno del servidor.
Si se quiere el callback automático: server_name/host sslip.io hacia Hormiga en nginx.
