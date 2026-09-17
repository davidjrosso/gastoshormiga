/**
 * Genera los íconos PNG de la PWA sin ninguna dependencia.
 *
 * Existe porque Chrome en Android no ofrece instalar la app si el manifest no
 * trae al menos un PNG de 192px o más — un SVG no alcanza. Y agregar `sharp`
 * al proyecto solo para dibujar dos círculos sería absurdo.
 *
 * Node trae zlib, así que se puede escribir un PNG válido a mano: firma,
 * IHDR, IDAT con los scanlines comprimidos, IEND.
 *
 * Correr con: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'public', 'icons');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function png(size, pixelFn) {
  // Cada scanline arranca con un byte de filtro (0 = sin filtro), después RGB.
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y, size);
      const off = y * stride + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // 8 bits por canal
  ihdr[9] = 2;  // color type 2 = RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filtro adaptativo
  ihdr[12] = 0; // sin entrelazado

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [15, 23, 42];      // slate-900
const DOT = [251, 146, 60];   // orange-400

/**
 * Tres puntos en diagonal, de mayor a menor: la fila de hormigas que se
 * lleva la plata de a poco. Legible incluso a 48px en una notificación.
 */
function icon(x, y, size) {
  const u = size / 24; // trabajamos en una grilla de 24 y escalamos
  const dots = [
    { cx: 7.5, cy: 16.5, r: 3.6 },
    { cx: 12,  cy: 12,   r: 2.6 },
    { cx: 16,  cy: 8,    r: 1.7 },
  ];
  for (const d of dots) {
    const dx = x / u - d.cx;
    const dy = y / u - d.cy;
    if (dx * dx + dy * dy <= d.r * d.r) return DOT;
  }
  return BG;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png(size, icon));
  console.log(`  ${file}`);
}
console.log('Íconos generados.');
