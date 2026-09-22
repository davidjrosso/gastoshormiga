# Tarjetas y adicionales (v0.2.0)

## Alcance

Modulo independiente para importar resumenes BBVA Visa, conciliar movimientos
y llevar liquidaciones por persona. Todas las personas generan un saldo a
entregar, incluido el titular. Un pago recibido y un importe asumido por el
titular son registros distintos, ambos parciales y reversibles.

No se insertan movimientos en `transactions` ni se alteran los reportes de
gastos existentes: el libro de liquidaciones de tarjeta es independiente.
Esto evita contar dos veces consumos ya registrados manualmente, pagos de
la tarjeta, adelantos y devoluciones. Una integracion con el libro de gastos
necesita una politica explicita de conciliacion antes de implementarse.

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
- `extract.ts` / `extract-worker.ts`: proceso hijo aislado con limite de
  tiempo (180 s), una extraccion simultanea por proceso y modelos OCR locales.
- `server/src/routes/statements.ts`: rutas autenticadas y sin cache.
- `web/src/pages/Tarjetas.tsx`: carga, revision, reparto y liquidacion.
- `web/src/components/StatementFields.tsx`: entradas monetarias y reparto.

Los PDFs no se guardan. Los importes, nombres, detalle financiero y nombre
del archivo si se conservan en SQLite. El texto completo solo vuelve al
navegador durante la lectura; no va al log ni a Git. La vista de texto es
una alternativa para corregir lecturas antes de volver a analizar.

## Pruebas y despliegue pendiente

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
del OCR con Node 22 Linux. La migracion v3 agrega dos tablas; no elimina ni
reescribe datos anteriores. El codigo viejo rechaza una DB v3: rollback
requiere el backup y cuidado con escrituras posteriores.

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
