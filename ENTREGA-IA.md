# Hormiga 0.4.1: cuotas contraidas

Cuotas comprometidas aparece contraido por defecto en Resumen y Movimientos.
Tocar el titulo abre o cierra el panel; conserva el detalle y calculos existentes.
Cambio limitado al contenedor compartido, sin dependencias ni migraciones nuevas.
Versiones server/web y lockfiles sincronizadas en 0.4.1; esquema SQLite v5.

Antes de activar: typecheck, 98 pruebas existentes, builds server/web con
APP_BASE=hormiga, revision de apertura/cierre en navegador y arranque en copia
consistente de la base sin modificar datos. Conservar assets de PWA anteriores.

Despliegue autorizado por David. Registrar commit y respaldo en inventario privado,
reiniciar solo Hormiga y verificar API, PWA y continuidad de Ticketera.
Conservar codigo anterior 0.4.0 para recuperacion; no restaurar automaticamente
la base ni reemplazarla con datos DEV.
