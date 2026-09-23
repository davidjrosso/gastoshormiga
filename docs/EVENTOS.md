# Eventos (v0.4.0)

Un gasto puede pertenecer a un evento, por ejemplo Vacaciones Cordoba 2027,
sin perder su categoria. Ingresos y transferencias no se etiquetan.

## Uso

- Acceso desde Resumen, Movimientos y Ajustes.
- Crear, renombrar, archivar y reactivar eventos del hogar.
- Asignar al cargar o editar un gasto, incluidos consumos de resumenes.
- En Movimientos: seleccionar gastos visibles y aplicar o quitar un evento
  en lote (hasta 500). La seleccion se limpia al cambiar mes o filtros.
- Filtrar movimientos y cuotas previstas por evento o Sin evento.
- Ver el costo confirmado acumulado y sus gastos, con paginacion de 50.
  ARS y USD se muestran separados y los reintegros restan. No se suman
  cuotas futuras al costo confirmado.

## Extraordinarios y tendencias

La opcion Extraordinario esta activada inicialmente y puede cambiarse.
Excluye los gastos del evento del grafico de gasto habitual, comparaciones
por categoria, comparacion mensual en USD y deteccion de gastos hormiga y
suscripciones. Se aplica tanto al periodo actual como a la base historica.

No excluye gastos del saldo, ingresos, ahorro, cuentas, reparto por persona,
totales mensuales, detalle por categoria ni compromisos futuros.
En que se fue conserva el total completo y distingue el importe habitual.
Cambiar la opcion recalcula las comparaciones historicas, no los importes.
Los eventos ordinarios permiten agrupar sin excluir de las tendencias.

Archivar impide nuevas asignaciones manuales y oculta el evento por defecto.
Conserva etiquetas, comparaciones y reglas de compras ya vinculadas. Se puede
reactivar. Quitar un evento de un gasto devuelve ese gasto al analisis habitual.

## Cuotas

Por defecto la etiqueta afecta solo al movimiento seleccionado. La opcion
Aplicar tambien a las otras cuotas etiqueta las cuotas ya incorporadas de
esa compra y guarda una regla para proximos resumenes y proyecciones.

Se identifica por cuenta, titular, destinatario del reparto, fecha original,
cupon, descripcion normalizada, moneda y cantidad total de cuotas. No usa el
importe ni la categoria editable. Sin cupon o con mas de una linea con la
misma identidad en el resumen, no se propaga: se requiere seleccion manual.
Una descripcion o cupon diferente en otro resumen no se interpreta por
similitud. Revisar esas cuotas manualmente.

Quitar la etiqueta con alcance a toda la compra tambien elimina la regla;
quitarla solo de un movimiento no cambia las otras cuotas. Las proyecciones
reciben el evento de la regla, nunca de una etiqueta individual.
La confirmacion del resumen y la herencia de eventos son atomicas.

## Datos y API

Migracion v4 a v5 aditiva: events, event_transactions y card_event_rules.
No modifica filas financieras ni documentos confirmados. Una etiqueta por
movimiento; al borrar un gasto manual se elimina su relacion por FK cascade.
El codigo 0.3.0 rechaza bases v5: no volver a ejecutarlo sobre una base migrada.

Rutas autenticadas, aisladas por hogar:

- GET/POST /api/events; PATCH /api/events/:id.
- POST /api/events/assign con transactionIds, eventId (null quita etiqueta)
  y allInstallments opcional. Validacion y lote en una transaccion IMMEDIATE.
- POST/PATCH /api/transactions acepta eventId; PATCH permite eventAllInstallments.
- GET /api/transactions e /api/analytics/installments aceptan eventId;
  vacio significa Sin evento, omitido no filtra.

La API de eventos no usa cache. No se levantan las restricciones de importe,
fecha, persona o borrado de movimientos vinculados a tarjetas.

## Verificacion

98 pruebas de servidor: migracion y datos previos, CRUD, aislamiento, lotes
atomicos, montos y monedas, tendencias y saldos, alcance individual/compra,
herencia futura, ambiguedad, eliminacion de reglas y archivado.
Typecheck y builds server/web con APP_BASE=hormiga.
QA en navegador con datos sinteticos: crear evento, aplicar dos gastos,
ver total y detalle, quitar una etiqueta y asociar toda una compra en cuotas.
