// Trusted public origin. In database_bootstrap mode the exact HTTPS origin is
// written by the in-network admin CLI into runtime_settings for this
// DEPLOYMENT_ID; until then sign-in and pairing stay disabled. Host and
// forwarded-host headers are never trusted.
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import { loadAppConfig } from '../lib/config';
import type { Db } from './db';
import { SafeError } from './util';

/** Validate a single origin: scheme + host (+port), no path/query/credentials/wildcard. */
export function validateOrigin(raw: string, opts: { allowHttpLocalhost?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeError('origin must be an absolute URL');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(opts.allowHttpLocalhost && local && u.protocol === 'http:')) throw new SafeError('origin must use https');
  if (u.username || u.password) throw new SafeError('origin must not contain credentials');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new SafeError('origin must not contain a path, query or fragment');
  if (u.hostname.includes('*')) throw new SafeError('origin must not contain wildcards');
  return u.origin;
}

let cache: { origin: string | null; at: number } | undefined;
const RELOAD_MS = 15_000;

export async function trustedOrigin(db: Db): Promise<string | null> {
  const cfg = loadAppConfig();
  if (cfg.PUBLIC_ORIGIN_MODE === 'explicit') {
    const v = cfg.APP_URL ?? cfg.BETTER_AUTH_URL;
    return v ? validateOrigin(v, { allowHttpLocalhost: cfg.APP_MODE !== 'hosted' }) : null;
  }
  if (cache && Date.now() - cache.at < RELOAD_MS) return cache.origin;
  let origin: string | null = null;
  if (cfg.DEPLOYMENT_ID) {
    const [row] = await db.select().from(s.runtimeSettings).where(eq(s.runtimeSettings.deploymentId, cfg.DEPLOYMENT_ID));
    origin = row ? validateOrigin(row.publicOrigin, { allowHttpLocalhost: cfg.APP_MODE !== 'hosted' }) : null;
  }
  cache = { origin, at: Date.now() };
  return origin;
}

export function resetOriginCache() {
  cache = undefined;
}

export async function bootstrapOrigin(db: Db, deploymentId: string, origin: string, actor: string, configRevision: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(deploymentId)) throw new SafeError('invalid deployment id');
  const o = validateOrigin(origin, { allowHttpLocalhost: process.env.APP_MODE !== 'hosted' });
  await db
    .insert(s.runtimeSettings)
    .values({ deploymentId, publicOrigin: o, configRevision, bootstrappedBy: actor, audit: { at: new Date().toISOString() } })
    .onConflictDoUpdate({ target: s.runtimeSettings.deploymentId, set: { publicOrigin: o, configRevision, bootstrappedBy: actor, bootstrappedAt: new Date() } });
  return o;
}
