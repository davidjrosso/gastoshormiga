import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de secretos en reposo (tokens OAuth de tiendas externas).
 *
 * AES-256-GCM con clave de 32 bytes en HORMIGA_TOKEN_KEY (base64). La clave vive
 * solo en el entorno del servidor, nunca en la base ni en el repositorio: una copia
 * de la base sola no alcanza para usar los tokens. Sin clave válida, las funciones
 * que dependen de secretos quedan deshabilitadas en vez de guardar en claro.
 *
 * Formato: v1.<iv>.<tag>.<cifrado>, todo base64url. `context` se autentica como
 * AAD, así un token copiado de otra fila/hogar no descifra.
 */
export class SecretBoxError extends Error {}

export function loadKey(raw = process.env.HORMIGA_TOKEN_KEY): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export function seal(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map(p => typeof p === 'string' ? p : p.toString('base64url')).join('.');
}

export function open(sealed: string, key: Buffer, context: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new SecretBoxError('Formato de secreto desconocido.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new SecretBoxError('No se pudo descifrar el secreto.'); }
}
