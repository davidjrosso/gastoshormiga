# Hormiga 0.6.0: cotización y carrito VEA

Implementación local solicitada por David el 29/09/2026. Desde Compras se pueden
seleccionar pendientes, recordar productos VEA, cotizar disponibilidad/precio en
Río Tercero y abrir un carrito con los disponibles. Pago/retiro se confirman en VEA.

Cantidades enteras 1–99, agrupación de presentaciones repetidas, cotización efímera
con vencimiento y selección de hasta 30 pendientes. Sin efectos sobre gastos,
precios históricos ni shopping_items. Compras offline conserva su conducta.
“En qué se fue” sigue por monto descendente; selectores alfabéticos.

0.6.0 en server/web y lockfiles; migración aditiva v7: store_settings y
store_product_links. Sin dependencias nuevas. Binarios <=0.5.2 rechazan v7.
API, límites y fuentes: docs/VEA.md.

111 pruebas server y 4 cliente, typecheck y builds APP_BASE=hormiga correctos.
Migración en copia sintética v6 conserva tablas/filas previas, integridad y FK.
Consulta pública y carrito anónimo con dos productos verificados. QA local web;
queda comprobación final Android con sesión de David y elección de retiro.

David autorizó desplegar 0.6.0 el 29/09/2026. Estado previo conocido: 0.5.2 / 07704a0 / esquema v6.
Antes de desplegar: autorización, estado real/commit, backup consistente y checksum,
migración en copia, builds Linux, código/assets previos. Reiniciar solo Hormiga,
comprobar Ticketera y registrar evidencia privada. Nunca reemplazar PROD por DEV.
