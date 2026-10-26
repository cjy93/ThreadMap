// Private object storage for cached attachments. S3 (Nebius Object Storage) in
// hosted mode; a local directory for development. Keys are derived from
// application IDs only, never from untrusted filenames.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadStorageConfig, type StorageConfig } from '../lib/config';

export interface StorageAdapter {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  check(): Promise<void>;
  readonly driver: 's3' | 'local';
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]{0,255}$/;
function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error('invalid object key');
}

export const attachmentObjectKey = (workspaceId: string, attachmentId: string) => `ws/${workspaceId}/att/${attachmentId}`;

class LocalStorage implements StorageAdapter {
  readonly driver = 'local' as const;
  constructor(private dir: string) {}
  private p(key: string) {
    assertKey(key);
    return path.join(path.resolve(this.dir), ...key.split('/'));
  }
  async put(key: string, bytes: Buffer) {
    const file = this.p(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  async get(key: string) {
    try {
      return await fs.readFile(this.p(key));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await fs.rm(this.p(key), { force: true });
  }
  async check() {
    await fs.mkdir(path.resolve(this.dir), { recursive: true });
  }
}

class S3Storage implements StorageAdapter {
  readonly driver = 's3' as const;
  private client: S3Client;
  constructor(private cfg: StorageConfig) {
    if (!cfg.S3_BUCKET || !cfg.S3_ENDPOINT || !cfg.S3_REGION) throw new Error('S3 storage requires S3_ENDPOINT, S3_REGION and S3_BUCKET');
    this.client = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      forcePathStyle: true,
      credentials:
        cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    assertKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, Body: bytes, ContentType: contentType }));
  }
  async get(key: string) {
    assertKey(key);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
      if (!r.Body) return null;
      return Buffer.from(await r.Body.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async delete(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
  }
  async check() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
  }
}

let shared: StorageAdapter | undefined;
export function getStorage(cfg: StorageConfig = loadStorageConfig()): StorageAdapter {
  if (!shared) shared = cfg.STORAGE_DRIVER === 's3' ? new S3Storage(cfg) : new LocalStorage(cfg.LOCAL_STORAGE_DIR);
  return shared;
}
export function createLocalStorage(dir: string): StorageAdapter {
  return new LocalStorage(dir);
}
