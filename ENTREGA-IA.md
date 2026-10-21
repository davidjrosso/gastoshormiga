# Hormiga 0.8.0 — Qué compramos y para quién

Base: main e37bcd7 (0.7.3). David autorizó implementar el replanteo y subirlo
 directamente a producción el 21/10/2026. Estado del despliegue: consultar
 CONTEXTO.local.md y el registro privado .local/contabo/HORMIGA-0.8.0-DESPLIEGUE.md.

Carga y edición de gastos: concepto, destinatario independiente del pagador,
categoría, cantidad/unidad opcionales y desglose cuyo total debe coincidir.
Comercio opcional; creación de categorías desde la carga. Categorías personales
históricas se sugieren como destinatarios, pendientes de revisión. No se
reescriben categorías, importes ni descripciones antiguas durante la migración.

Resumen: categorías, conceptos, destinatarios, pagadores, repeticiones habituales
y pendientes de revisión. Orden descendente por importe, ARS/USD separados.
Gastos imputados conserva fecha de cierre. Consumos por fecha usa la fecha del
banco para consumos sin cuotas; excluye cuotas y conserva cargos por imputación.
No calcula el valor total supuesto de una compra en cuotas ni lo duplica.
Se muestran cobertura por origen y mes, y aviso de mes en curso; se retiran las
variaciones automáticas sobre períodos no comparables.

Tarjetas: nombre entendible del consumo sin cambiar documento bancario.
Aplicación opcional a cuotas de la misma compra por identidad exacta existente;
reglas para próximas cuotas. Nunca propagar a todo un comercio. Cantidades y
partes no se propagan. Cuotas comprometidas usa el concepto identificado.
Comprado, lista de compras, VEA/ML y eventos conservan su funcionamiento.

Versión 0.8.0 en server/web y lockfiles. Esquema v9: solo agrega expense_details
 y card_concept_rules; tablas previas intactas. No se puede volver a un binario
v8 sobre una base v9: cualquier reversión requiere revisión explícita.
Sin dependencias nuevas. Tests nuevos: server/tests/expenses.test.ts.
Manual del nuevo flujo: docs/CONSUMOS.md. Manual de tarjetas actualizado.
Pruebas requeridas: typecheck/test/build server, test/build web APP_BASE=hormiga,
QA de formulario y Resumen con datos ficticios, migración en copia consistente,
comparación exacta de todas las tablas previas, API autenticada de producción.
No publicar datos del hogar ni documentación privada de infraestructura.