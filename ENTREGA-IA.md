# Hormiga 0.3.0: cuotas comprometidas

Los resumenes confirmados ahora permiten consultar cuotas futuras en Resumen
y Movimientos, con detalle por compra, persona, moneda y mes de finalizacion.
El ultimo resumen de cada tarjeta reemplaza la base de proyeccion anterior.
Las cuotas estimadas permanecen separadas de los gastos confirmados.

## Alcance tecnico

- Backend y frontend 0.3.0; package.json y lockfiles sincronizados.
- Sin dependencias nuevas ni migraciones: esquema SQLite v4.
- Endpoint autenticado de solo lectura, aislado por hogar y sin cache.
- Compatible con resumenes ya incorporados; no requiere recarga ni backfill.
- Frontend compilado con APP_BASE=hormiga; conservar assets anteriores para PWA abiertas.
- No modifica configuracion compartida ni datos de otras aplicaciones.

## Validacion

88 pruebas, typecheck y compilaciones de server/web correctas en Windows.
Revision en navegador con datos sinteticos, navegacion futura y filtro por persona.
Antes de activar: repetir comprobaciones en Linux y probar el arranque de la
base sobre una copia consistente, verificando que conserve el esquema y datos.

## Activacion y recuperacion

Registrar el commit exacto de esta entrega en el inventario privado del despliegue.
Respaldar SQLite mediante backup API y conservar codigo/dependencias anteriores.
Reiniciar exclusivamente Hormiga. Comprobar salud 0.3.0, endpoint privado,
proyeccion autenticada, archivos PWA y continuidad de la otra aplicacion.
Si falla, reponer el codigo anterior; no sustituir la base por una base DEV.

Ver docs/TARJETAS.md para las reglas de proyeccion y sus limites.
