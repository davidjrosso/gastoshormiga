# VEA — Hormiga 0.6.0

Desde Compras, “Cotizar en VEA” consulta los pendientes seleccionados, permite elegir
una presentación del catálogo y abre VEA con los disponibles. El retiro, horario,
pago y precio definitivo se confirman en VEA.

## Comportamiento

- Sucursal inicial: Vea Río Tercero, retiro en Modesto Acuña 58. Canal 34,
  vendedor jumboargentinav690riotercerocentro, código postal 5850.
- Ajustes permite guardar esta sucursal para el hogar; todavía no hay otras.
- Los vínculos nombre+marca → producto se comparten dentro del hogar y sobreviven
  al historial y a repetir listas. Se pueden cambiar o quitar.
- Texto libre en cantidad se propone como 1, con aviso. Solo se infieren enteros
  puros de 1 a 99. Ajustar la cotización no reescribe el ítem original.
- Hasta 30 pendientes seleccionados por cotización. En listas más grandes se
  eligen los primeros 30 y el usuario puede cambiar la selección.
- Los SKU repetidos suman cantidades antes de simular stock/precio (máximo 99).
- Total de productos: suma subtotales enteros de la simulación, incluidos descuentos
  de producto devueltos por VEA. No incluye cargos ni descuentos de medios de pago.
- Sin vínculo, stock suficiente, precio válido o retiro confirmado: informar y excluir
  del carrito. Un precio faltante no se considera un precio cero del producto.
- Presentaciones por peso/fraccionadas: no se convierten automáticamente; revisar en VEA.
- Precio, total, fecha y URL solo viven en memoria. Vigencia máxima 2 minutos;
  cambiar cantidades, selección o lista exige actualizar antes de abrir el carrito.
- Sin conexión o con cambios pendientes de sincronizar no se cotiza. Compras conserva
  sus funciones offline, incluyendo agregar, tachar y deshacer.
- “Comprado”, cotizar, vincular y abrir carrito no registran precios ni gastos.

## API y migración

Rutas bajo /api/shopping/stores/vea, dentro del middleware de Compras: sesión y
X-Hormiga-Household / X-Hormiga-User coincidentes. Cache-Control: no-store, PWA NetworkOnly.

- GET /settings; PUT /settings con salesChannel y sellerId permitidos.
- GET /search?q=…: hasta 10 presentaciones con oferta de la sucursal.
- PUT /links/:itemKey: itemId, sku, packQty (por defecto 1). El servidor deriva la
  clave del ítem del hogar y valida nombre/EAN contra el catálogo.
- DELETE /links/:itemKey: elimina solo el vínculo del hogar autenticado.
- POST /quote: items:[{itemId,qty}]. Rechaza ítems ajenos, comprados, archivados,
  ID repetidos, cantidades inválidas o más de 30 ítems.

v7 agrega store_settings y store_product_links. No modifica tablas financieras,
categorías, eventos, shopping_items ni recibos offline. No hay dependencias nuevas,
credenciales VEA, sesiones VEA o datos de pago en Hormiga. Binarios <=0.5.2 rechazan v7.

Cliente en server/src/stores/vea.ts: dominio HTTPS fijo, redirecciones JSON rechazadas,
timeout 8 segundos, caché acotada en memoria (catálogo 10 minutos, simulación 2 minutos,
200 entradas). Cotizaciones separadas por hogar. Máximo 30 solicitudes por minuto y
2 simultáneas por hogar. Errores externos recuperables no detienen Compras.

## Verificaciones y límites

Verificado públicamente el 29/09/2026: catálogo y simulación sin login del vendedor
indicado. Con CP 5850 devuelve “Retiro en Tienda - Vea Río Tercero Modesto Acuña 58”.
La sucursal publica ese SLA como delivery, no pickup-in-point: se comprueba su nombre.

Un carrito anónimo separado confirmó que el enlace con parámetros repetidos conserva
ambos SKU, cantidades, vendedor y canal 34, y redirige al checkout. No garantiza que
un navegador con sesión previa conserve la entrega: revisar sucursal/retiro en VEA.
No se completó ningún pedido ni pago.

111 pruebas server y 4 cliente, typecheck y builds correctos. Pruebas sin red de
migración, aislamiento, caché, errores/timeout, límites, stock, agrupación y ausencia
de efectos financieros. Copia sintética v6→v7 conserva las 20 tablas previas y sus
filas; integridad y claves foráneas correctas.

QA local de navegador con base sintética y consultas reales a VEA: búsqueda,
vinculación, cantidades libres, recotización y vista móvil. La comprobación final
Android con sesión de David sigue siendo manual; Chrome de escritorio no certifica
la apertura en una app Android.

Fuentes consultadas:
- [Checkout API VTEX](https://developers.vtex.com/docs/api-reference/checkout-api)
- [Retiro con vendedores VTEX](https://developers.vtex.com/docs/guides/setting-up-white-label-seller-as-pickup-point)
- [Preguntas frecuentes VEA](https://www.vea.com.ar/faq-frecuentes)
- [Condiciones VEA](https://www.vea.com.ar/terminos-y-condiciones)

La consulta pública no constituye un acuerdo de integración; la API puede cambiar.
Si falla, informar al usuario y mantener Compras disponible.

## Entrega

Server/web y lockfiles 0.6.0. Desplegar solo con autorización y el procedimiento
privado: verificar commit activo, backup SQLite consistente, migración en copia,
build Linux APP_BASE=hormiga, preservar código/assets y reiniciar solo Hormiga.
Comprobar Ticketera; no restaurar automáticamente bases al revertir código.
