# Hormiga 0.7.3: comparación de categorías y manual de tarjetas

Preparado localmente sobre main 7778c09 (0.7.2 desplegada). Sin despliegue de 0.7.3.
Server/web y ambos lockfiles actualizados a 0.7.3; esquema v8 sin cambios.

"En qué se fue" compara gasto habitual con el promedio de hasta tres meses previos
que tengan gastos del hogar. Omite meses sin gastos registrados; cuenta el cero de
una categoría cuando sí hubo otros gastos en ese mes. Muestra meses de referencia,
promedio y aviso de mes en curso. Conserva orden por monto descendente y exclusión
de eventos extraordinarios del gasto habitual. Un mes con registros puede estar incompleto.

Manual de uso: docs/MANUAL-TARJETAS.md, desde PDF y revisión hasta incorporación al
hogar, pagos de adicionales y cuotas futuras. Pruebas nuevas: category-trends.test.ts.
Las pruebas de detectores usan una fecha fija para evitar fallas al iniciar el mes.

## Antecedente 0.7.2 (ya desplegado)

Base: main 72b22a3 (0.7.1, desplegada con la comparación VEA / ML). Rama fix/ml-busqueda.
David reportó que al buscar en ML a veces aparecía "Sin ofertas" aunque la app de ML mostraba
productos. Diagnóstico con su cuenta (30/09/2026): no es intermitente; el catálogo devuelve
primero fichas sin ofertas o sin Full, y Hormiga solo miraba las primeras 6 y 20 ofertas.

Cambios: la búsqueda revisa hasta 30 fichas y 100 ofertas por ficha, ordena primero las Full
más baratas, acepta enlaces de ficha /p/MLA… pegados desde la app y, si no hay Full, lo
explica y ofrece abrir la búsqueda en ML. La comparación también lee ofertas paginadas.
Sin migraciones ni dependencias nuevas; esquema v8 sin cambios. Detalle: docs/ML.md.

Server/web y lockfiles 0.7.2. Pruebas server (incluye regresión del caso diagnosticado),
cliente, typecheck y builds APP_BASE=hormiga correctos.

0.7.2 desplegada el 30/09/2026. Parches de seguridad de claude/SEGURIDAD-2026-09-29.md siguen pendientes.
Antes de desplegar: autorización, estado real/commit, backup consistente, builds Linux,
código/assets previos. Reiniciar solo Hormiga y comprobar Ticketera. Nunca reemplazar PROD por DEV.
