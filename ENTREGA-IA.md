# Hormiga 0.7.2: búsqueda en Mercado Libre

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

NO desplegado. Parches de seguridad de claude/SEGURIDAD-2026-09-29.md siguen pendientes.
Antes de desplegar: autorización, estado real/commit, backup consistente, builds Linux,
código/assets previos. Reiniciar solo Hormiga y comprobar Ticketera. Nunca reemplazar PROD por DEV.
