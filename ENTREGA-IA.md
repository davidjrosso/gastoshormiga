# Hormiga 0.4.0: eventos

Los gastos pueden agruparse por evento y marcarse como extraordinarios para
excluirlos de las tendencias habituales, conservandolos en los totales.
Incluye asignacion individual/en lote y alcance explicito a compras en cuotas.

## Alcance tecnico

- Backend y frontend 0.4.0; package.json y lockfiles sincronizados.
- Sin dependencias nuevas. Migracion aditiva SQLite v4 a v5 (tres tablas).
- Endpoints autenticados, aislados por hogar; eventos sin cache.
- Compatible con resumenes ya incorporados; no requiere recarga ni backfill.
- Frontend compilado con APP_BASE=hormiga; conservar assets anteriores para PWA abiertas.
- No modifica configuracion compartida ni datos de otras aplicaciones.

## Validacion

98 pruebas, typecheck y compilaciones de server/web correctas en Windows.
Revision en navegador con datos sinteticos: CRUD, lote, detalle y cuotas.
Antes de activar: repetir comprobaciones en Linux y probar el arranque de la
base sobre una copia consistente, verificando esquema v5 e identidad de las
filas previas. Esta entrega local no autoriza un despliegue nuevo.

## Activacion y recuperacion

Registrar el commit exacto de esta entrega en el inventario privado del despliegue.
Respaldar SQLite mediante backup API y conservar codigo/dependencias anteriores.
Reiniciar exclusivamente Hormiga. Comprobar salud 0.4.0, eventos, movimientos,
cuotas, archivos PWA y continuidad de la otra aplicacion.
El codigo 0.3.0 rechaza bases v5: una recuperacion requiere evaluar el backup
previo y escrituras posteriores; no restaurar la base automaticamente ni
sustituirla por una base DEV.

Ver docs/EVENTOS.md y docs/TARJETAS.md para alcance y limites.
