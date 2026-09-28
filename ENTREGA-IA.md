# Hormiga 0.5.1: Compras compartidas

Entrega local autorizada: navegacion, carga rapida, lista compartida offline e
iconos. Comprado tacha a la derecha; no crea precios ni gastos. Ahorros conserva
pantalla/datos y pasa a Ajustes. Ver docs/COMPRAS.md.

Server/web y lockfiles en 0.5.1. Sin dependencias nuevas. Migracion aditiva v6:
shopping_items y shopping_operations. No modifica datos financieros existentes.
Las versiones hasta 0.4.1 rechazan v6; no usarlas sobre una base ya migrada.

Validacion: 105 pruebas server y 3 del modelo cliente, typecheck, builds con
APP_BASE=hormiga. QA sintetico de desconexion/reconexion, conflictos,
historial, duplicados y vista movil. Sin cambios en PROD.

David autorizo subir a Git y desplegar esta entrega el 28/09/2026. Antes de activar:
comprobar commit real, backup consistente y checksum, probar migracion en copia,
instalar con lockfiles Linux, compilar con APP_BASE=hormiga, conservar assets PWA
y codigo previos. Reiniciar solo Hormiga y comprobar Ticketera. No restaurar
automaticamente la base ni reemplazarla con DEV. Registrar evidencia privada.

Categorias ordenadas alfabeticamente en espanol (sin distinguir mayusculas o
acentos) en administracion, selectores y Resumen. Version 0.5.1.
