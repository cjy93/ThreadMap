import crypto from 'node:crypto';

export class EncryptionKeyError extends Error {}

/** Parse the base64 32-byte WHATSAPP_AUTH_ENCRYPTION_KEY. Never generates one implicitly. */
export function parseEncryptionKey(b64: string | undefined): Buffer {
  if (!b64) throw new EncryptionKeyError('WHATSAPP_AUTH_ENCRYPTION_KEY is not configured; relink/setup required');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new EncryptionKeyError('WHATSAPP_AUTH_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

export interface Sealed {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, tag: c.getAuthTag(), ciphertext };
}

export function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, s.iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(s.tag);
  try {
    return Buffer.concat([d.update(s.ciphertext), d.final()]);
  } catch {
    throw new EncryptionKeyError('stored WhatsApp auth/media data cannot be decrypted with the configured key; relink required');
  }
}

/** Single-buffer packing: version(1) | iv(12) | tag(16) | ciphertext. */
export function sealPacked(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const s = seal(key, plaintext, aad);
  return Buffer.concat([Buffer.from([1]), s.iv, s.tag, s.ciphertext]);
}

export function openPacked(key: Buffer, packed: Buffer, aad: string): Buffer {
  if (packed[0] !== 1) throw new EncryptionKeyError('unknown sealed format');
  return open(key, { iv: packed.subarray(1, 13), tag: packed.subarray(13, 29), ciphertext: packed.subarray(29) }, aad);
}
