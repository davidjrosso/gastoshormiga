# Compras — v0.6.0

Lista compartida por hogar. Compras reemplaza Ahorros en la barra inferior;
Ahorros conserva su ruta y datos, con acceso desde Ajustes. El carrito verde
sobre el boton de carga de gastos abre la carga rapida.

## Uso

- Nombre obligatorio; cantidad, unidad, marca, nota y urgencia opcionales.
- Pegar hasta 100 productos, uno por renglon. Los detalles opcionales se aplican
  a todos los renglones de esa carga. Rubros independientes de las categorias.
- Advertir duplicados por nombre/marca normalizados; se pueden agregar igualmente.
- Contador de productos pendientes, no unidades. "No consegui" sigue pendiente.
- "Comprado", a la derecha, tacha y lleva al final. Destachar o deshacer sin red.
- "Estoy en el super" amplia las filas; no pide ubicacion ni notifica a nadie.
- Guardar comprados en el historial retira solo esos productos y deja faltantes.
  Se puede deshacer y repetir una lista historica, omitiendo los ya pendientes.
- Frecuentes usa productos comprados. Urgentes aparecen primero en cada rubro.

Marcar, desmarcar, repetir e historial NO crean gastos, precios, transacciones
ni movimientos de tarjeta. Los importes se registran por separado.
Presupuestos, integracion contable, historial/comparacion de precios, recordatorios y geofencing
quedan fuera de esta entrega.

## Sin conexion y concurrencia

Abrir y autenticar la PWA con conexion al menos una vez en cada dispositivo.
IndexedDB guarda copia y cola por hogar/usuario. Solo se confirma guardado luego
de persistir la operacion. El perfil local sin contrasena, cookie ni token de
sesion permite reabrir sin red hasta siete dias desde la ultima autenticacion.
Cerrar sesion o recibir 401/403 lo invalida; la cola queda para el mismo usuario
al volver a ingresar. No borrar datos del navegador con cambios pendientes.

UUID estable por operacion y recibos durables del servidor evitan duplicados.
Transacciones IndexedDB, BroadcastChannel y Web Locks coordinan las pestanas.
Revisiones monotonas rechazan snapshots viejos. Se sincroniza al abrir, recuperar
conexion, volver a la app y cada diez segundos con pagina visible. Actualizar
reintenta manualmente. Con la app cerrada la cola espera hasta volver a abrirla.

Cada cambio incluye valores originales de sus campos. Campos distintos se
combinan; colisiones conservan la version compartida y la propuesta local para
elegir. Se pausa solo ese producto, dejando avanzar los demas. Archivar verifica
estado comprado; cambios offline viejos no reabren historial automaticamente.

Compras y autenticacion usan NetworkOnly en la PWA. Compras usa no-store y
verifica que hogar y usuario de la cola coincidan con la sesion del servidor.

## API y migracion

Esquema v6: shopping_items (campos de lista, revision, fecha) y
shopping_operations (recibos idempotentes). Solo agrega tablas. No modifica
tablas financieras, eventos ni categorias.

- GET /api/shopping: snapshot con revision y productos, incluido historial.
- POST /api/shopping/operations: alta o cambio parcial con estado original.
- Cookie y encabezados X-Hormiga-Household / X-Hormiga-User coincidentes con
  la sesion son obligatorios. Los encabezados solos no otorgan acceso.
- 409 permite revisar conflictos; 401/403 detienen la sincronizacion.

No arrancar versiones hasta 0.4.1 sobre v6. Para desplegar: migracion en copia
consistente, backup/codigo previos y procedimiento privado de infraestructura.
No restaurar automaticamente bases ni reemplazar PROD por DEV.

## Iconos

Lucide compartido y selector buscable en Categorias. Compatibilidad visual con
iconos antiguos, sin reescribir nombres/colores. Seleccion guarda lucide:<id>.
Hijos/hijas usan persona e inicial; mascotas, huella. Movimientos, carga,
edicion y fijos usan el mismo render; select nativos muestran solo el nombre.

## Validacion

Pruebas de migracion, aislamiento, reintentos, conflictos concurrentes,
historial/deshacer y ausencia de efectos financieros. Modelo cliente: cola
persistida, snapshots viejos y duplicados. npm run typecheck, npm test y
npm run build en server; npm test y APP_BASE=hormiga npm run build en web.

QA con base sintetica y corte de conexion a la API: alta multiple, comprado,
deshacer, recarga sin servidor, reconexion, conflicto entre integrantes y
resolucion, historial/repetir, frecuentes y duplicados. Vista de ancho movil.
No se usaron ni modificaron datos productivos.

Categorias ordenadas alfabeticamente en espanol (sin distinguir mayusculas o
acentos) en administracion y selectores. En Resumen, "En que se fue" va por monto de mayor a menor. Version 0.6.0.

## Cotizacion VEA (0.6.0)

Cotizacion temporal y carrito disponibles con conexion. Ver [VEA.md](VEA.md).
Esquema actual v7: agrega preferencias y vinculos por hogar; no modifica
las tablas de Compras de v6. Binarios hasta 0.5.2 no aceptan bases v7.

## Comparar VEA / Mercado Libre (0.7.0)

Compara pendientes entre VEA Río Tercero (retiro) y ofertas Full de Mercado Libre,
con resúmenes Todo VEA, Todo ML y Mixto, y abre los carritos. Requiere conectar
Mercado Libre en Ajustes. Ver [ML.md](ML.md). Esquema v8: agrega cuentas de tiendas
(tokens cifrados) y estados OAuth; binarios hasta 0.6.0 no aceptan bases v8.
