import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, PSM, type Worker } from 'tesseract.js';

const require = createRequire(import.meta.url);
type Word = { x: number; y: number; text: string };
function rows(words: Word[], tolerance: number) {
  const groups: { y: number; words: Word[] }[] = [];
  for (const w of words.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = groups.at(-1);
    if (last && Math.abs(last.y - w.y) <= tolerance) last.words.push(w);
    else groups.push({ y: w.y, words: [w] });
  }
  return groups
    .map((g) =>
      g.words
        .sort((a, b) => a.x - b.x)
        .map((w) => w.text)
        .join(' '),
    )
    .join('\n');
}

process.once('message', async (message: { data: string }) => {
  let ocr: Worker | undefined;
  let task: ReturnType<typeof getDocument> | undefined;
  try {
    task = getDocument({
      data: new Uint8Array(Buffer.from(message.data, 'base64')),
      useSystemFonts: true,
    });
    const doc = await task.promise;
    if (doc.numPages > 15) throw new Error('El PDF supera las 15 paginas permitidas.');
    const pages: string[] = [];
    let usedOcr = false;
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const text = await p.getTextContent();
      let pageText = rows(
        text.items
          .filter((i): i is Extract<typeof i, { str: string }> => 'str' in i)
          .map((i) => ({ x: i.transform[4], y: -i.transform[5], text: i.str })),
        3,
      );
      if (pageText.trim().length < 80) {
        if (!ocr) {
          const language = require('@tesseract.js-data/spa') as { langPath: string };
          ocr = await createWorker('spa', 1, {
            langPath: language.langPath,
            cacheMethod: 'none',
            gzip: true,
          });
          await ocr.setParameters({
            tessedit_pageseg_mode: PSM.AUTO,
            preserve_interword_spaces: '1',
          });
        }
        const viewport = p.getViewport({ scale: 2.5 });
        if (viewport.width * viewport.height > 12_000_000)
          throw new Error('Una pagina del PDF es demasiado grande.');
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await p.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext('2d') as never,
          viewport,
        }).promise;
        const result = await ocr.recognize(
          canvas.toBuffer('image/png'),
          {},
          { tsv: true, text: true },
        );
        const words: Word[] = [];
        for (const line of (result.data.tsv ?? '').split('\n').slice(1)) {
          const c = line.split('\t');
          if (c[0] === '5' && c[11]?.trim())
            words.push({
              x: Number(c[6]),
              y: Number(c[7]) + Number(c[9]) / 2,
              text: c.slice(11).join(' ').trim(),
            });
        }
        pageText = rows(words, 8);
        if (pageText.trim().length > 20) usedOcr = true;
        canvas.width = canvas.height = 1;
      }
      pages.push(pageText);
      p.cleanup();
    }
    process.send?.({ text: pages.join('\n'), usedOcr });
  } catch (e) {
    process.send?.({
      error:
        e instanceof Error && /paginas|demasiado grande/.test(e.message)
          ? e.message
          : 'No se pudo leer el PDF. Verifica que no tenga clave ni este dañado.',
    });
  } finally {
    await ocr?.terminate();
    await task?.destroy();
    process.disconnect();
  }
});
