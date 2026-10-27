// Better Auth with PostgreSQL sessions, initialized only once the trusted
// public origin is known. Re-created if the bootstrapped origin changes.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { loadAppConfig } from '../lib/config';
import { getDb, type Db } from './db';
import { trustedOrigin } from './origin';
import { SafeError } from './util';
import type { AuthCtx } from './api/service';

function build(db: Db, origin: string) {
  const cfg = loadAppConfig();
  if (!cfg.BETTER_AUTH_SECRET || cfg.BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  return betterAuth({
    appName: 'ThreadMap',
    baseURL: origin,
    secret: cfg.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    // No passwords: scanning the WhatsApp QR is the sign-in (see startWhatsAppLogin).
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 7 },
    // Anonymous sessions start both the demo and a WhatsApp link; allow a
    // classroom/judging burst from one network while still bounding abuse.
    rateLimit: {
      enabled: true,
      storage: 'memory', // single web process per Endpoint
      window: 60,
      max: 300,
      customRules: { '/sign-in/anonymous': { window: 60, max: 30 } },
    },
    advanced: { useSecureCookies: origin.startsWith('https://') },
    plugins: [anonymous({ emailDomainName: 'demo.threadmap.invalid' })],
  });
}

export type Auth = ReturnType<typeof build>;
let current: { origin: string; auth: Auth } | undefined;

/** Returns null while the deployment has no bootstrapped trusted origin. */
export async function getAuth(): Promise<Auth | null> {
  const db = getDb();
  const origin = await trustedOrigin(db);
  if (!origin) return null;
  if (!current || current.origin !== origin) current = { origin, auth: build(db, origin) };
  return current.auth;
}

export async function getOrigin(): Promise<string | null> {
  return trustedOrigin(getDb());
}

/**
 * Resolve the authenticated user and workspace. Mutations additionally require
 * an Origin header equal to the trusted origin (CSRF protection).
 */
export async function requireUser(req: Request, opts: { mutation?: boolean } = {}): Promise<AuthCtx> {
  const auth = await getAuth();
  if (!auth) throw new SafeError('service is not configured yet', 503, 'not_ready');
  if (opts.mutation) {
    const origin = await getOrigin();
    const h = req.headers.get('origin');
    if (!h || h !== origin) throw new SafeError('cross-origin request rejected', 403, 'bad_origin');
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw new SafeError('sign in required', 401, 'unauthenticated');
  const db = getDb();
  const u = session.user as { id: string; isAnonymous?: boolean | null };
  const mode = await workspaceModeFor(db, u);
  const [ws] = await db.select().from(schema.workspaces).where(and(eq(schema.workspaces.ownerUserId, u.id), eq(schema.workspaces.mode, mode)));
  if (!ws) {
    if (mode === 'demo') {
      if (!loadAppConfig().PUBLIC_DEMO_ENABLED) throw new SafeError('the public demo is disabled on this deployment', 403, 'demo_disabled');
      const { ensureDemoWorkspace } = await import('./demo');
      const d = await ensureDemoWorkspace(db, u.id);
      return { userId: u.id, workspaceId: d.id, mode };
    }
    throw new SafeError('no workspace for this account', 403, 'no_workspace');
  }
  if (ws.expiresAt && ws.expiresAt < new Date()) {
    throw new SafeError(mode === 'demo' ? 'demo session expired; start a new demo' : 'this WhatsApp link attempt expired; scan again', 401, 'expired');
  }
  return { userId: u.id, workspaceId: ws.id, mode };
}

/**
 * A session with a private workspace (pending or claimed through WhatsApp) is
 * private even while still anonymous; other anonymous sessions are demo guests.
 */
export async function workspaceModeFor(db: Db, u: { id: string; isAnonymous?: boolean | null }): Promise<'private' | 'demo'> {
  const [priv] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(and(eq(schema.workspaces.ownerUserId, u.id), eq(schema.workspaces.mode, 'private')));
  return priv || !u.isAnonymous ? 'private' : 'demo';
}

export function requireOwner(ctx: AuthCtx) {
  if (ctx.mode !== 'private') throw new SafeError('not available in the public demo', 403, 'demo_forbidden');
  const cfg = loadAppConfig();
  if (!cfg.WHATSAPP_PAIRING_ENABLED) throw new SafeError('WhatsApp pairing is disabled on this deployment', 403, 'pairing_disabled');
}
