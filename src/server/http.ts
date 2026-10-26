import { requireUser } from './auth';
import type { AuthCtx } from './api/service';
import { SafeError } from './util';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function errorResponse(e: unknown) {
  if (e instanceof SafeError) return json({ error: e.code, message: e.message }, e.status);
  // Never echo internal errors (could contain private data); log a content-free line.
  console.error('request failed:', e instanceof Error ? e.name : 'unknown');
  return json({ error: 'internal', message: 'Something went wrong' }, 500);
}

const MAX_BODY = 256 * 1024;
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new SafeError('request body too large', 413, 'too_large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeError('invalid JSON body');
  }
}

type Handler<P> = (ctx: AuthCtx, req: Request, params: P) => Promise<unknown>;

/** Authenticated JSON route: resolves the workspace, enforces Origin on mutations. */
export function authed<P = Record<string, string>>(fn: Handler<P>) {
  return async (req: Request, route: { params: Promise<P> }) => {
    try {
      const ctx = await requireUser(req, { mutation: req.method !== 'GET' && req.method !== 'HEAD' });
      return json(await fn(ctx, req, await route.params));
    } catch (e) {
      return errorResponse(e);
    }
  };
}
