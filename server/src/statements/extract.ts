import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One isolated extraction per process bounds CPU/memory and keeps the API responsive.
let busy = false;
export async function extractPdf(data: Buffer): Promise<{ text: string; usedOcr: boolean }> {
  if (busy) throw new Error('Ya hay un resumen en lectura. Espera y vuelve a intentar.');
  if (data.length > 12 * 1024 * 1024 || data.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Selecciona un PDF valido de hasta 12 MB.');
  busy = true;
  try {
    return await new Promise((resolve, reject) => {
      const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
      const child = fork(fileURLToPath(new URL(`./extract-worker${suffix}`, import.meta.url)), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production' },
        execArgv: [
          ...process.execArgv.filter(
            (arg, i, args) =>
              !arg.startsWith('--input-type') &&
              arg !== '-e' &&
              arg !== '--eval' &&
              args[i - 1] !== '-e' &&
              args[i - 1] !== '--eval',
          ),
          '--max-old-space-size=768',
        ],
      });
      let done = false;
      const finish = (error?: Error, value?: { text: string; usedOcr: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error('La lectura excedio 3 minutos. Divide el resumen en un PDF mas pequeño.'),
          ),
        180_000,
      );
      child.on('error', () => finish(new Error('No se pudo iniciar el lector de PDF.')));
      child.on('exit', () => finish(new Error('El lector de PDF se interrumpio.')));
      child.on('message', (v: { error?: string; text: string; usedOcr: boolean }) => {
        if (v.error) finish(new Error(v.error));
        else if (typeof v.text !== 'string' || v.text.length > 500_000)
          finish(new Error('El texto extraido supera el limite.'));
        else finish(undefined, v);
      });
      child.send({ data: data.toString('base64') });
    });
  } finally {
    busy = false;
  }
}
