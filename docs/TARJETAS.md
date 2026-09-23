# Tarjetas y adicionales (v0.4.0)

Los consumos y cuotas pueden etiquetarse con eventos. El alcance individual
o a toda la compra es explicito; ver [EVENTOS.md](EVENTOS.md). Un evento
extraordinario no reduce el importe de cuotas comprometidas. Se puede filtrar
por evento en Movimientos. El esquema actual es v5 por las tablas de eventos.

## Cuotas comprometidas

Resumen y Movimientos permiten navegar a meses futuros y consultar las cuotas
proyectadas, separadas de los gastos confirmados. Resumen muestra seis meses;
Movimientos muestra el mes seleccionado y respeta el filtro por persona.
Cada detalle indica compra, persona, tarjeta, cuota y mes de finalizacion.

La base es el ultimo resumen confirmado de cada cuenta de tarjeta. Se toman
solo consumos positivos en cuotas con movimientos efectivamente incorporados
al hogar, por su importe asignado y moneda original. Se excluyen borradores,
consumos excluidos, reintegros, impuestos, intereses y Solo liquidacion.
Las cuentas archivadas conservan compromisos ya asumidos.

Se proyectan cuotas n+1 hasta N, un mes por cuota desde el mes del cierre,
conservando el importe de la ultima cuota facturada. ARS y USD permanecen
separados. El vencimiento que se muestra corresponde al resumen fuente;
no se inventan fechas futuras de cierre o vencimiento.

Un nuevo resumen confirmado sustituye la base completa de esa tarjeta; no se
suman proyecciones de resumenes anteriores ni se intenta identificar compras
por similitud de texto. El mes ya facturado no agrega cuotas proyectadas: sus
consumos estan en los movimientos confirmados. Si el nuevo resumen no tiene
movimientos incorporados al hogar, se informa y no se reutiliza el anterior.
Esto presupone resumenes completos: no se arrastran planes ausentes del ultimo.
Si faltan resumenes, se conserva la estimacion con su fecha de referencia.

El porcentaje compara exclusivamente cuotas ARS con ingresos ARS del ultimo
mes con ingreso positivo entre los tres meses completos anteriores al mes
actual (o al consultado, si es anterior). El periodo y el importe de referencia
se muestran; no se presentan como un sueldo futuro garantizado. El filtro por
persona aplica tambien al ingreso. Sin referencia no se calcula porcentaje.

API autenticada: GET /api/analytics/installments?period=AAAA-MM&months=6.
Admite de 1 a 24 meses y paidBy opcional; aisla datos por hogar y no usa cache.
La proyeccion es de solo lectura, no genera movimientos y no altera saldos.
Funciona con resumenes ya cargados. Las cuotas se introdujeron en v0.3.0 sin
migracion; v0.4.0 agrega las tablas de eventos (esquema v5).

Validacion v0.3.0: typecheck, 88 pruebas, compilaciones server/web con
APP_BASE=hormiga y revision local en navegador con datos sinteticos.

## Alcance

Modulo independiente para importar resumenes BBVA Visa, conciliar movimientos
y llevar liquidaciones por persona. Todas las personas generan un saldo a
entregar, incluido el titular. Un pago recibido y un importe asumido por el
titular son registros distintos, ambos parciales y reversibles.

Las liquidaciones siguen separadas. En Movimientos del hogar se vincula cada
titular con un usuario propio o se deja Solo liquidacion. No se adivinan nombres.
La seleccion se recuerda por hogar para futuras confirmaciones. Un borrador
no genera gastos. Tambien se pueden incorporar resumenes ya confirmados.

Solo se incorporan consumos, impuestos, intereses y percepciones no excluidos,
por el importe asignado al titular seleccionado. No se incorporan adelantos,
pagos bancarios, creditos de percepcion de otros periodos ni cobros/canjes del
libro de liquidaciones. Los reintegros de consumos conservan signo negativo
como reduccion de gasto, no como ingresos. No hay conversion ARS/USD.

La fecha contable es el cierre; la fecha original y cuota quedan en la nota.
Asi una cuota de una compra antigua afecta al mes facturado. El usuario del
movimiento es el del titular elegido, no quien confirma. No se asocia
automaticamente a los demas adicionales aunque el titular asuma sus deudas.

Confirmacion e incorporacion son atomicas. El vinculo resumen/renglon/persona
es unico y repetir no duplica movimientos. Una coincidencia exacta con un gasto
manual en tarjeta, fecha (compra/cierre), descripcion y monto bloquea todo el
alta; requiere revision. No detecta todas las posibles cargas manuales con
descripciones diferentes. Los movimientos vinculados permiten cambiar categoria,
comercio y nota, pero no importe, fecha, usuario ni borrado independiente.

## Flujo

1. Cargar un PDF (hasta 12 MB, 15 paginas). Se extrae texto con PDF.js y se
   usa Tesseract local cuando hace falta. No se envian documentos a terceros.
2. Se crea o recupera el borrador por SHA256 del archivo, acotado al hogar.
3. Elegir la cuenta de tipo tarjeta; revisar cierre, vencimiento y saldos.
4. Revisar los consumos por titular y las cuotas del periodo. La fecha de
   compra se conserva; no se confunde con el periodo del resumen.
5. Asignar cargos generales a una persona o repartirlos. El prorrateo es
   una propuesta manual por consumos ARS o USD, no una determinacion fiscal.
   Distribuye centavos por resto mayor sin perder dinero por redondeo.
6. Las percepciones RG 5617 quedan pendientes incluso si se elige pagar
   con dolares. Excluirlas requiere un motivo y verificacion del usuario.
   No se presume que hubo devolucion. IVA, IIBB y sellos no se excluyen juntos.
7. Confirmar solo si los saldos globales y subtotales por titular coinciden,
   las fechas son validas y no quedan movimientos sin clasificar/asignar.
8. Registrar pagos o importes asumidos, siempre por persona y moneda. No se
   convierte moneda automaticamente ni se cobra dos veces por doble clic.

Los pagos bancarios y creditos de percepcion de periodos anteriores se
excluyen inicialmente de lo nuevo a cobrar. El usuario revisa esa exclusion.
Los saldos anteriores participan en la conciliacion con el banco, pero no
se transforman otra vez en deuda por persona. Los saldos personales viejos
permanecen en sus liquidaciones originales.

## Componentes

- `server/src/import`: parser bancario puro, con fechas y totales verificados.
- `server/src/statements/model.ts`: tipos y calculos compartidos con React;
  no accede a DB ni dependencias de servidor.
- `validation.ts`: limites y validacion de las entradas HTTP.
- `repository.ts`: transacciones SQLite, aislamiento por hogar, duplicados,
  versiones de borradores y cancelaciones.
- `movements.ts`: vinculacion explicita de usuarios e incorporacion idempotente.
- `extract.ts` / `extract-worker.ts`: proceso hijo aislado con limite de
  tiempo (180 s), una extraccion simultanea por proceso y modelos OCR locales.
- `server/src/routes/statements.ts`: rutas autenticadas y sin cache.
- `web/src/pages/Tarjetas.tsx`: carga, revision, reparto y liquidacion.
- `web/src/components/StatementFields.tsx`: entradas monetarias y reparto.

Los PDFs no se guardan. Los importes, nombres, detalle financiero y nombre
del archivo si se conservan en SQLite. El texto completo solo vuelve al
navegador durante la lectura; no va al log ni a Git. La vista de texto es
una alternativa para corregir lecturas antes de volver a analizar.

## Pruebas y despliegue

Node >=22.13.0. Usar `npm ci` en server y web. Las dependencias nativas deben
instalarse en el sistema de destino, nunca copiar node_modules de Windows
a Linux. PDF.js, canvas, Tesseract y el modelo espanol vienen en el lockfile.

```text
cd server
npm run typecheck
npm test
npm run build
cd ../web
npm run build
```

Para desarrollo aislado: DATABASE_PATH debe apuntar a una base de pruebas.
PORT permite otro puerto para la API. API_TARGET en Vite debe apuntar a ese
puerto. APP_BASE mantiene soporte para el despliegue en subdirectorio.

Antes del despliegue: backup consistente SQLite, ensayo en copia y prueba
del OCR con Node 22 Linux. La migracion v4 agrega las tablas de vinculacion;
no incorpora gastos automaticamente al arrancar ni cambia datos previos.
La migracion v5 agrega eventos, relaciones y reglas de compra. El codigo de
versiones anteriores rechaza una base mas nueva: rollback requiere evaluar
el backup y las escrituras posteriores.

Configurar en el proxy de Hormiga un limite de subida de al menos 13 MB y
timeout mayor a 180 s solo para el analisis de PDFs. Mantener sin cambios
las rutas de las otras aplicaciones. No se ha cambiado configuracion remota.

La PWA usa NetworkOnly para este modulo. En despliegue comprobar que el
service worker nuevo se activo y que no se muestran datos del usuario
anterior sin conexion. La cache historica de otros endpoints no cambia.

Los resumenes confirmados no admiten reemplazo. Los borradores si se
pueden corregir. Antes de habilitar reemplazos de confirmados hay que
definir que hacer con cobros ya registrados; no se borran silenciosamente.

## Otras ramas

La rama `feat/importar-resumen`, commit `5ccb474`, contiene otra implementacion
independiente y otra migracion v3. No forma parte de esta entrega. No desplegar
esa rama sobre esta base ni resolver su futuro merge eligiendo una migracion
arbitrariamente. Primero hay que unificar ambos historiales y probar una
migracion explicita. Esta version rechaza al arrancar una v3 de otra rama.
