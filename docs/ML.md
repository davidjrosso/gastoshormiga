# Mercado Libre y comparación VEA/ML — Hormiga 0.7.1

Desde Compras, “Comparar VEA / ML” consulta hasta 30 pendientes en VEA Río Tercero
con retiro y en Mercado Libre con ofertas Full nuevas en ARS. Abre carritos;
la compra y el pago se completan en cada tienda.

## Precios y cantidades

- VEA conserva el subtotal de la simulación, incluidos descuentos. Si dos pendientes
  usan el mismo SKU, se reparte el subtotal en centavos sin alterar su suma.
- ML elige el menor precio entre las primeras 20 ofertas recibidas para cada ficha;
  no afirma ser el mínimo de todo el catálogo. Excluye publicaciones que informan
  estado inactivo, stock cero, condición desconocida/usada o moneda distinta de ARS.
- Si ML informa cantidad disponible se valida también la suma de pendientes vinculados
  a la misma publicación. Si no la informa, el checkout debe confirmar stock/cantidad.
- Hasta 99 unidades por publicación/SKU sumadas entre pendientes. Los límites o errores
  de ML se muestran por producto y no eliminan los resultados de VEA.
- La persona debe vincular presentaciones equivalentes (marca, tamaño, contenido).
  Hormiga no convierte pesos, volúmenes o multipacks para inferir equivalencias.
- Todo VEA muestra la suma de subtotales disponibles; Todo ML muestra productos y
  **envío a confirmar en ML**. No se deduce el envío conjunto a partir de envíos individuales.
- El mixto es una propuesta por subtotal, no una garantía de ahorro. Su parte VEA se
  vuelve a simular porque al quitar productos pueden desaparecer promociones. Si esa
  simulación falla o pierde stock, se ocultan sus carritos y el total queda sin confirmar.
- Full no se presenta como garantía de un único paquete. Stock, envío, beneficios Meli+
  y cantidad de paquetes se confirman en el checkout. La búsqueda puede mostrar una
  referencia de envío individual; no se suma al total del carrito.

Cotizaciones solo en memoria. Vigencia máxima de dos minutos desde la consulta original,
respetando la antigüedad de la caché y la expiración más temprana. Editar la lista, quedar
sin conexión o vencer la cotización bloquea la apertura desde la interfaz hasta actualizar.
No registra gastos, precios históricos ni cambios en shopping_items. Comprado solo tacha.

## Cuenta de Mercado Libre

David confirmó que la aplicación de ML ya está creada. Se reutiliza el callback sslip.io de la prueba previa: no hace falta comprar un dominio.
La configuración privada está preparada localmente; falta transferirla con autorización,
instalar el certificado válido de ese hostname y completar OAuth desde la aplicación.

En Ajustes, Conectar abre ML en otra pestaña. OAuth usa PKCE y un state aleatorio de un
solo uso, ligado a la persona/hogar, con vencimiento de 10 minutos. El callback público
valida ese state. Una sesión ajena no lo consume. Iniciar otra conexión invalida la anterior.

Los tokens y el verificador PKCE se cifran con AES-256-GCM y contexto por hogar/state.
El refresh se comparte entre consultas concurrentes. Desconectar invalida OAuth pendiente
y en curso; un refresh atrasado no puede recrear ni reemplazar una conexión nueva.
Implementación para el proceso único de Hormiga; no desplegar múltiples workers OAuth
sin reemplazar la invalidación en memoria por coordinación persistente.

Se requiere un callback HTTPS con certificado válido para su hostname, idéntico al
registrado en ML Developers. No usar avisos de certificado como parte del flujo.
La alternativa de pegar la URL sirve para recuperación con HTTPS válido, no para
omitir una configuración TLS correcta. La persona autoriza en ML; no ingresar su clave
ni tokens en el chat ni guardarlos en Git.

## Configuración privada

Ver los placeholders en server/.env.example. El proceso debe recibir:

| Variable | Uso |
| --- | --- |
| ML_CLIENT_ID | ID de la aplicación existente |
| ML_CLIENT_SECRET | Secreto de la aplicación, solo entorno privado |
| ML_REDIRECT_URI | https://dominio/hormiga/api/ml/callback, certificado válido |
| ML_RETURN_URL | Opcional: https://dominio/hormiga/ajustes |
| ML_POSTAL_CODE | Opcional, por defecto 5850 |
| HORMIGA_TOKEN_KEY | 32 bytes aleatorios en base64; conservar en actualizaciones y backups privados |

Sin configuración completa ML queda deshabilitado y VEA sigue disponible. No rotar
HORMIGA_TOKEN_KEY por cada despliegue: las conexiones existentes dependen de esa clave.
Los scopes se revisan en la app existente; Hormiga consulta catálogo y ofertas, no realiza
compras ni usa funciones de escritura sobre la cuenta. El intercambio OAuth usa POST.

## API, límites y esquema

Rutas autenticadas bajo /api/shopping, con sesión y encabezados coincidentes:

- GET /stores/ml/status; POST /stores/ml/connect; POST /stores/ml/complete {url}; DELETE /stores/ml/connection.
- GET /stores/ml/search?q=; PUT /stores/ml/links/:itemKey {itemId,productId}; DELETE /stores/ml/links/:itemKey.
- POST /compare {items:[{itemId,qty}]}: filas, resúmenes, errores parciales, vigencia y carritos.

Callback público GET /api/ml/callback?code&state, no-store y no-referrer. Excluir los
query strings OAuth de los logs de acceso del proxy al configurar ese endpoint.
El service worker deja /api/ en red y no intercepta el callback como navegación SPA.

Cliente de dominio fijo, sin redirects, timeout 8s por llamada. Comparación: cuatro
consultas ML concurrentes y presupuesto compartido de 20s después de obtener el token;
se preservan resultados parciales. Caché de ofertas con timestamps originales y
separada por token; catálogo 10min y ofertas/envío 2min. Límite por hogar 20 comparaciones
por minuto y una activa, búsqueda/vínculos ML 30/min y dos activas, conexión10/min.

Esquema v8: agrega store_accounts y store_oauth_pending; conserva tablas financieras,
Compras y vínculos v7. Binarios hasta0.6.0 rechazan v8. Sin dependencias nuevas.

El carrito ML usa un enlace no documentado (`gz/checkout/cart/buy`). Se probó previamente
por otra IA en PC; requiere verificación con sesión real en Android antes de dar por
cerrada la integración. Si el enlace deja de funcionar, abrir ML y agregar los productos
manualmente. Ninguna prueba debe confirmar una compra.

## Entrega y verificación

Versión0.7.1 coherente en server/web y lockfiles. Pruebas sin red cubren aislamiento,
migración sintética, cifrado, OAuth concurrente, promociones VEA, reparto de centavos,
caché, errores parciales, cantidades repetidas y listas de30 con proveedor lento.

Antes de producción: confirmar HTTPS y redirect registrado, guardar secretos por el
procedimiento privado, probar OAuth/checkout en PC y Android, ejecutar checks y ensayar
migración sobre copia consistente. Desplegar solo con autorización y siguiendo
AGENTS.md e infraestructura privada; reiniciar solo Hormiga y verificar Ticketera.
