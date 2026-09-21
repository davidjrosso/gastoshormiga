# hormiga

Control de la economía del hogar para dos personas, pensado para Argentina.

Lleva los gastos del día a día y los fijos, los ingresos, y el ahorro en
dólares. Lo que la distingue de una planilla es el **detector de gasto
hormiga**: encuentra las compras chicas y repetidas que individualmente no
duelen y juntas se llevan un alquiler por año.

Es una PWA: se instala en Android desde Chrome y se abre igual en el navegador
de la PC. Una sola base de código, sin Play Store ni APK.

---

## Cómo está armado

```
hormiga/
├── server/          API + base de datos (Node, Hono, SQLite)
│   ├── src/
│   │   ├── db/          esquema, migraciones, datos de ejemplo
│   │   ├── analytics/    detector de hormiga y módulo de ahorro
│   │   ├── import/       resúmenes de tarjeta: un parser por banco
│   │   ├── fx/           cotizaciones del dólar
│   │   ├── routes/       endpoints HTTP
│   │   └── lib/          plata, fechas, normalización
│   └── data/        la base vive acá (no va al repo)
├── web/             front (React, Vite, Tailwind, PWA)
└── Dockerfile       despliegue en un solo contenedor
```

**Por qué SQLite y no Postgres.** Para dos usuarios, Postgres es sobreingeniería
que cuesta RAM en un VPS compartido con otras apps, agrega un servicio más para
mantener y complica el backup. Con SQLite el backup es copiar un archivo.
El ORM es Drizzle, así que si algún día hace falta migrar, el camino existe.

---

## Levantarlo en tu máquina

Requiere Node 20 o superior. No hace falta Docker para desarrollar.

```bash
cd server && npm install && cd ../web && npm install
```

Dos terminales:

```bash
cd server && npm run dev
```

```bash
cd web && npm run dev
```

El front queda en <http://localhost:5173> y manda `/api` al server en el 3001.

### Datos de ejemplo

Para ver la app con contenido antes de cargar nada real:

```bash
cd server && npm run seed -- --demo
```

Crea un hogar con cuatro meses de movimientos realistas —incluido un café
diario, un kiosco, una suscripción que aumenta todos los meses y compras
mensuales de dólares— y el usuario `demo@hormiga.local` / `demo1234`.

Para empezar de cero, borrá `server/data/hormiga.db` y volvé a arrancar.

### Tests

```bash
cd server && npm test
```

Corren con `node:test` sobre una base temporal nueva en cada ejecución, así que
no tocan `data/hormiga.db` ni dependen del seed. No hay framework de testing:
para un proyecto de este tamaño, una dependencia más que mantener no se paga.

Lo que cubren es lo que se rompe en silencio: el parseo de montos en formato
argentino, las tres condiciones del detector de gasto hormiga —cada test saca
una y verifica que el gasto deje de aparecer—, la materialización de los gastos
fijos, la edición de movimientos con su aislamiento entre hogares, y la
importación de resúmenes de tarjeta —incluido el caso de subir el mismo PDF dos
veces, que es lo que cualquiera hace por las dudas—.

El resumen de prueba es **inventado**. Este repo es público y un resumen real
es el detalle de dónde vive y qué compra una familia: el fixture reproduce el
formato y las rarezas del banco con datos de fantasía que cierran por
construcción.

```bash
cd server && npm run typecheck
```

El `build` compila solo `src`, porque los tests no tienen por qué terminar en
`dist`. `typecheck` los incluye, que si no un error de tipos en un test recién
aparece al correrlo.

### Verificar el motor de análisis a ojo

```bash
cd server && npx tsx scripts/check.ts
```

Imprime por consola el resumen del mes, los goteos detectados, las
suscripciones y los saldos. Los tests dicen si algo se rompió; esto sirve para
mirar si los números tienen sentido, que no es lo mismo.

---

## El modelo mental (importa)

Tres tipos de movimiento, y la diferencia no es cosmética:

| Tipo | Qué significa |
|---|---|
| **Gasto** | La plata sale de casa. |
| **Ingreso** | La plata entra a casa. |
| **Transferencia** | La plata cambia de lugar pero sigue siendo tuya. |

**Comprar dólares es una transferencia, nunca un gasto.** Sacar efectivo del
cajero también. Es el error que arruina a la mayoría de estas apps: te computan
la compra de USD 300 como un gasto de medio millón de pesos y el resumen del mes
queda inservible. Acá una transferencia no suma ni a ingresos ni a gastos, y
además guarda el tipo de cambio al que la hiciste, que es lo que después permite
saber a cuánto compraste en promedio.

**Cargá el comercio, no solo la categoría.** Es la diferencia entre "gastaste
$93.000 en Café y kiosco" —que no te deja hacer nada— y "el café de la esquina
son $585.000 al año", que sí.

### Quién pagó vs. quién cargó

Cada movimiento guarda dos personas distintas, y la diferencia importa:

- **`paidByUserId`** — quién puso la plata. Es lo que se filtra y lo que suma
  en "Quién pagó qué" del resumen.
- **`createdByUserId`** — quién tocó el botón en la app.

No siempre coinciden: anotar a la noche la compra que hizo el otro a la mañana
es lo normal en una pareja. Si eso quedara a nombre de quien lo cargó, los
totales por persona mentirían. Por eso la carga rápida deja elegir quién pagó,
y ese es el campo que usan los informes.

En un gasto fijo el dato vive en la **regla**, no en la transacción: el
movimiento lo genera el sistema, así que atribuírselo a quien abrió la app ese
día sería inventar un dato. Se elige en Ajustes de cada fijo y puede quedar sin
asignar, que es lo correcto cuando sale de la cuenta conjunta.

---

## Cómo funciona el detector de gasto hormiga

Un gasto se marca como hormiga cuando cumple las tres condiciones a la vez:

1. **Es frecuente**: aparece al menos una vez por mes.
2. **Es chico**: el ticket promedio está por debajo del 0,5% del ingreso mensual.
3. **Suma**: el total del mes *supera* ese mismo 0,5%.

La tercera es la que le da sentido a las otras dos. La definición de gasto
hormiga es precisamente ésa: *el agregado cruza un umbral que ninguna compra
individual cruza*. Un gasto chico y aislado no es nada; uno grande y repetido ya
lo ves venir. El daño está donde se cruzan.

**No hay umbrales fijos en pesos en ninguna parte del código.** Escribir "es
hormiga si es menor a $3.000" sería garantizar que el detector quede inservible
en seis meses. Todo se calcula contra el ingreso del propio hogar, así que se
recalibra solo a medida que los números crecen.

### Comparar meses sin que la inflación mienta

Cada transacción guarda la cotización del dólar del día en que ocurrió. Con eso
la app puede expresar cualquier gasto pasado en dólares del momento, y mostrar
las tendencias como porcentaje del ingreso. Comparar septiembre contra marzo en
pesos nominales no dice nada útil; qué proporción de lo que entró se fue en cada
cosa, sí.

Si después corregís la fecha de un movimiento, la cotización se vuelve a
congelar contra el día corregido —si no, quedaría valuado contra el dólar de un
día que no es—. Pero solo si hay alguna cargada: pisar con nada una cotización
que ya teníamos dejaría el movimiento sin valuar a cambio de nada, y sin
internet ese es justo el caso.

Las cotizaciones se traen de [dolarapi.com](https://dolarapi.com) (pública, sin
API key) cada seis horas. El servidor solo pide el precio del día: no manda
ningún dato tuyo. Si no hay internet, se usa la última cotización conocida, y
siempre podés cargarla a mano desde Ajustes.

---

## Importar el resumen de la tarjeta

Subís el PDF del resumen y la app carga el mes entero de una. Es la forma más
barata de cargar gastos que existe: el resumen ya trae el comercio escrito, que
es justo el campo que uno saltea cuando carga a mano y sin el cual el detector
de gasto hormiga no ve nada.

**El PDF no se sube a ningún lado.** El texto se extrae en tu propio
dispositivo con pdf.js y al servidor viaja solo eso, y solo cuando confirmás.
Un resumen de tarjeta es el detalle de dónde vivís, qué comprás y cuándo
viajás; no hace falta que salga de tu teléfono para contar renglones.

### Un resumen NO es una lista de gastos

Es la decisión que hace que esto sirva o arruine el mes. Adentro viene
mezclado, y cada cosa entra distinto:

| Renglón | Entra como | Por qué |
|---|---|---|
| Consumo | **Gasto** | Es lo que compraste. |
| Cuota | **Gasto** con `n/N` | Guardar la cuota evita que el detector vea seis compras repetidas y marque un goteo que no existe. |
| Interés, sellos, IVA, IIBB | **Gasto** | Del que no se ve: nadie revisa el resumen renglón por renglón. |
| **Pago de la tarjeta** | **Transferencia** | Cancela una deuda. Contarlo como gasto duplica el consumo del mes anterior. |
| **Adelanto** | **Transferencia** | Sacaste plata de la tarjeta; el gasto viene después, cuando la uses. |
| **Percepción RG 5617 (30%)** | **Transferencia** | Vuelve el mes siguiente. Ver abajo. |

### La percepción del 30% no es un gasto

Si pagás el saldo en dólares, ARCA devuelve la percepción del 30% en el resumen
siguiente (aparece como `CR.RG 5617 30% M`). O sea que no es plata que perdiste:
es plata tuya en manos del fisco por 30 días.

Cargarla como gasto hace dos daños: el mes figura peor de lo que fue, y al mes
siguiente aparece un ingreso fantasma que nadie entiende tres meses después. Por
eso va a una cuenta **"Percepciones a recuperar"**, que la app crea sola, y el
crédito hace el camino inverso. Es el mismo tratamiento que la compra de
dólares: plata que cambia de lugar, no que se va.

Como efecto secundario, el saldo de esa cuenta te dice cuánto tenés inmovilizado
esperando que te lo devuelvan.

> El IVA RG 4240 y la percepción de IIBB **no** vuelven, así que ésos sí entran
> como gasto. La distinción importa: en un resumen de ejemplo eran $179.313 que
> volvían contra $19.904 que no.

### Deduplicación

Cada renglón tiene una huella estable —cuenta, cierre del resumen, fecha, cupón,
importe y cuota— con un índice **UNIQUE** en la base. Reimportar el mismo PDF no
duplica nada, y la garantía no depende de que la lógica esté bien: la base
rechaza el duplicado igual.

El cierre del resumen entra en la huella a propósito. Una cuota aparece varios
meses seguidos con el mismo cupón y el mismo importe, y son cargos distintos:
sin el cierre, la cuota 4/6 se confundiría con la 3/6 y el importador se comería
una por mes.

### Nada entra sin que lo veas

Antes de confirmar, la pantalla muestra los renglones uno por uno: cuáles son
nuevos, cuáles ya estaban, qué entra como gasto y qué como transferencia, y
cuáles se ignoran **con el motivo**. Importar ochenta renglones a ciegas es la
forma más rápida de ensuciar una base que después nadie limpia.

Y hay una condición para poder confirmar: el parseo tiene que **cerrar al
centavo** contra los totales que declara el propio resumen, global y por
titular. Un parser de PDF no falla con una excepción, falla perdiendo un renglón
y devolviendo un número creíble; si la suma no da, no se importa nada.

### Agregar otro banco

El parser trabaja sobre el texto ya extraído y devuelve un `ParsedStatement`.
Todo lo específico del banco vive en un archivo (`server/src/import/bbva-visa.ts`);
el resto del importador no sabe de dónde vino el resumen. Sumar un banco es
escribir otro archivo como ése.

---

## Compartir el hogar con tu pareja

1. Creás tu cuenta, que crea el hogar.
2. Entrás a **Ajustes** y copiás el código de invitación.
3. Tu pareja crea su cuenta pegando ese código.

Quedan los dos sobre los mismos datos, y cada movimiento registra quién lo
cargó. Compartí el código por un canal privado: quien lo tenga puede sumarse
al hogar y ver todos los movimientos.

---

## El despliegue actual

Corriendo en un VPS (Ubuntu 24.04) que **comparte con otra aplicación** ya
existente. Las dos detrás del mismo nginx, en la misma IP y sin dominio, así
que hormiga vive en un subdirectorio: `https://<servidor>/hormiga/`.

> Los datos concretos del despliegue —IP, usuario, rutas— están en
> `DEPLOY.local.md`, que no se versiona. Este README describe **cómo** está
> armado y **por qué**, que es lo que le sirve a cualquiera que lo lea.

### Por qué systemd y no Docker

El `Dockerfile` y el `docker-compose.yml` siguen en el repo y funcionan, pero
en este servidor se descartaron por dos razones:

1. **Docker se saltea ufw.** Inserta sus propias reglas de iptables, así que
   publicar un puerto puede exponerlo a internet aunque el firewall diga que
   no. Ese VPS tiene ufw bien configurado y no vale la pena arriesgarlo.
2. **El servidor ya tiene un patrón que funciona**: servicio systemd en
   localhost, nginx adelante. La otra app hace exactamente eso. Copiarlo es más
   fácil de mantener que introducir un runtime nuevo para una app de dos
   usuarios.

### Cómo está armado

| Qué | Dónde |
|---|---|
| Código | `/opt/hormiga/{server,web}` |
| Base de datos | `/var/lib/hormiga/hormiga.db` |
| Servicio | `/etc/systemd/system/hormiga.service`, como usuario `hormiga` |
| Secretos | `/etc/hormiga.env` (modo 640, `root:hormiga`) |
| nginx | `/etc/nginx/snippets/hormiga.conf`, incluido desde el site que ya existía |

El proceso escucha solo en `127.0.0.1:3001` y corre con endurecimiento de
systemd: sin privilegios nuevos, `/` de solo lectura, y como única ruta
escribible `/var/lib/hormiga`.

### Servida en un subdirectorio

Sin dominio propio, la app cuelga de `/hormiga/` en la misma IP que la otra
aplicación. Eso obliga a tres cosas, y conviene entenderlas antes de tocar nada:

- **El front se compila con `APP_BASE`**: `APP_BASE=hormiga npm run build`.
  De ahí salen las URLs de los assets, el `basename` del router y el
  `start_url`/`scope` del manifest. Sin eso, Android instalaría la PWA
  apuntando a la raíz del servidor, que es la otra app.
- **nginx recorta el prefijo** (la barra final de `proxy_pass http://127.0.0.1:3001/`),
  así que el backend sigue viendo `/api/...` y no sabe que está en un subdirectorio.
- **La cookie de sesión va acotada a `/hormiga`** vía `COOKIE_PATH`. Como las dos
  apps comparten origen, con el `path=/` por defecto el navegador le mandaría
  la sesión de hormiga a la otra app en cada request. Sin separación de origen,
  la separación hay que hacerla a mano.

### Redesplegar

```bash
cd web    && APP_BASE=hormiga npm run build
cd server && npm run build
tar czf - -C server dist | ssh $SRV 'tar xzf - -C /opt/hormiga/server'
tar czf - -C web    dist | ssh $SRV 'tar xzf - -C /opt/hormiga/web'
ssh $SRV 'sudo systemctl restart hormiga'
```

(`$SRV` es `usuario@servidor`; el valor real está en `DEPLOY.local.md`.)

### Acceso al servidor

Por clave SSH, con un usuario sin privilegios que tiene sudo. El login de
`root` por SSH está deshabilitado a propósito, igual que la autenticación por
contraseña. **No revertir eso**: es la configuración correcta.

---

## Antes de exponerlo a internet

- **Definí `REGISTRATION_CODE`.** Sin eso, cualquiera que llegue a la URL puede
  crearse una cuenta en tu servidor. Una vez que los dos tengan cuenta,
  cambiá el valor por cualquier otra cosa y el registro queda cerrado.
- **Sacá el usuario de demo** si lo creaste: sus credenciales están en este
  archivo, o sea que son públicas.
- **HTTPS con certificado válido.**

## Backups

La base entera es un archivo. Para copiarla en caliente sin riesgo de agarrarla
a mitad de una escritura:

```bash
sqlite3 data/hormiga.db ".backup '/ruta/backup/hormiga-$(date +%F).db'"
```

Copiar el archivo con `cp` mientras el server escribe puede dejarte un backup
corrupto, porque el modo WAL mantiene datos en `-wal` que `cp` no levanta.

Ponelo en un cron diario. Son gastos de años: el día que los quieras, los vas
a querer de verdad.

---

## Lo que falta

- **Etapa 2: IOL.** El esquema ya tiene las tablas `holdings` y las cuentas de
  tipo `inversion` para no tener que migrar cuando lleguemos. Las credenciales
  van a ir por variable de entorno; la app nunca las va a pedir por pantalla.
- Convertir una suscripción detectada en gasto fijo con un toque.
- Poder ignorar un comercio en el detector, para los goteos que no pensás cortar.
- Presupuestos por categoría con aviso al pasarse.
- El bundle del front pesa 584 kB, casi todo Recharts. Si molesta en el celular,
  se parte con `import()` dinámico en la pantalla que usa gráficos.
