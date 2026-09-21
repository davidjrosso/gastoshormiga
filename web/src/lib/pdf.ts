/**
 * Extracción del texto de un PDF, en el navegador.
 *
 * Que corra acá y no en el server es deliberado: un resumen de tarjeta es el
 * detalle de dónde vivís, qué comprás y cuándo viajás. Extrayendo el texto en
 * tu propio dispositivo, el archivo nunca se sube: al servidor viaja solo el
 * texto, y solo cuando apretás importar.
 *
 * pdf.js pesa, así que se carga con `import()` dinámico y queda en su propio
 * chunk: solo lo baja quien entra a importar un resumen.
 */

/**
 * Cuánto pueden diferir dos fragmentos en vertical y seguir siendo el mismo
 * renglón. Sin esta tolerancia, un valor desalineado por un punto se cae a una
 * línea propia: en el resumen de BBVA eso le pasa a la fecha de cierre, que
 * queda separada de su rótulo y deja de poder leerse por posición.
 */
const TOLERANCIA_FILA = 3;

/**
 * Separación mínima para considerar que hay un espacio entre dos fragmentos.
 *
 * pdf.js emite las letras acentuadas como fragmentos aparte ("Cr", "é",
 * "dito"). Uniendo todo con espacios sale "Cr é dito" y se rompe cualquier
 * búsqueda de texto. Midiendo el hueco real, las partes de una misma palabra
 * se pegan y las columnas distintas se separan.
 */
const HUECO_ESPACIO = 1;

export async function pdfATexto(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  // El worker se sirve desde nuestro propio origen, sin CDN: la app tiene que
  // seguir funcionando sin internet una vez instalada.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const paginas: string[] = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const contenido = await (await doc.getPage(n)).getTextContent();

    const fragmentos = (contenido.items as Array<{ str: string; width: number; transform: number[] }>)
      .filter((i) => i.str !== '')
      .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width ?? 0, s: i.str }))
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const filas: Array<typeof fragmentos> = [];
    for (const f of fragmentos) {
      const ultima = filas[filas.length - 1];
      if (ultima && Math.abs(ultima[0].y - f.y) <= TOLERANCIA_FILA) ultima.push(f);
      else filas.push([f]);
    }

    paginas.push(
      filas
        .map((fila) => {
          const ordenada = [...fila].sort((a, b) => a.x - b.x);
          let linea = '';
          let finAnterior: number | null = null;
          for (const f of ordenada) {
            if (finAnterior !== null && f.x - finAnterior > HUECO_ESPACIO) linea += ' ';
            linea += f.s;
            finAnterior = f.x + f.w;
          }
          return linea.trimEnd();
        })
        .join('\n'),
    );
  }

  await doc.destroy();
  return paginas.join('\n');
}
