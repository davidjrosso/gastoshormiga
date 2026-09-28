# Hormiga 0.5.2: orden por monto en Resumen

Corrige "En que se fue": categorias de mayor a menor importe del mes.
Administracion y selectores conservan el orden alfabetico en espanol.
Server/web y ambos lockfiles actualizados a 0.5.2.

Sin dependencias nuevas, migraciones ni cambios de datos respecto de 0.5.1.
El esquema permanece en v6 y Compras conserva su comportamiento.

Validacion requerida: typecheck, 105 pruebas server, 3 cliente y builds con
APP_BASE=hormiga. Comprobar orden descendente en navegador de produccion.

Correccion del despliegue autorizado por David el 28/09/2026.
Antes de activar: verificar commit, backup consistente y arranque en copia,
compilar Linux, conservar codigo/assets anteriores, reiniciar solo Hormiga
 y comprobar Ticketera. No reemplazar PROD por DEV. Registro privado en .local/.
