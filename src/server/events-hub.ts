// Web-process fan-out of committed change notifications (pg LISTEN) to
// authenticated SSE subscribers, scoped by workspace. QR payloads are kept only
// in bounded memory until expiry and are surfaced only to the owner workspace.
import pg from 'pg';
import { pgSslOptions } from './db';
import { EVENTS_CHANNEL, QR_CHANNEL, type ChangeEvent } from './notify';

type Listener = (ev: { type: string; data: unknown }) => void;

interface Hub {
  subs: Map<string, Set<Listener>>;
  qr: Map<string, { qr: string; expiresAt: number }>;
  client?: pg.Client;
  starting?: Promise<void>;
}

const g = globalThis as unknown as { __tmHub?: Hub };
const hub: Hub = (g.__tmHub ??= { subs: new Map(), qr: new Map() });

function emit(ws: string, ev: { type: string; data: unknown }) {
  for (const l of hub.subs.get(ws) ?? []) l(ev);
}

async function start(): Promise<void> {
  if (hub.client) return;
  if (hub.starting) return hub.starting;
  hub.starting = (async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: pgSslOptions(), application_name: 'threadmap-web-listen' });
    client.on('error', () => {
      hub.client = undefined;
      hub.starting = undefined;
      // Subscribers refetch by version on their next notice; reconnect shortly.
      setTimeout(() => void start().catch(() => undefined), 2000);
    });
    await client.connect();
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    await client.query(`LISTEN ${QR_CHANNEL}`);
    client.on('notification', (n) => {
      try {
        const payload = JSON.parse(n.payload ?? '{}');
        if (n.channel === QR_CHANNEL) {
          const { ws, qr, ttlMs } = payload as { ws: string; qr: string | null; ttlMs?: number };
          if (qr) hub.qr.set(ws, { qr, expiresAt: Date.now() + Math.min(ttlMs ?? 60_000, 120_000) });
          else hub.qr.delete(ws);
          emit(ws, { type: 'qr', data: { available: Boolean(qr) } });
          return;
        }
        const ev = payload as ChangeEvent;
        emit(ev.ws, { type: 'change', data: { kind: ev.kind, chatId: ev.chatId, version: ev.version, userId: ev.userId } });
      } catch {
        /* ignore malformed notices */
      }
    });
    hub.client = client;
  })();
  try {
    await hub.starting;
  } finally {
    hub.starting = undefined;
  }
}

export async function subscribe(ws: string, l: Listener): Promise<() => void> {
  await start();
  const set = hub.subs.get(ws) ?? new Set<Listener>();
  set.add(l);
  hub.subs.set(ws, set);
  return () => {
    set.delete(l);
  };
}

export function currentQr(ws: string): string | null {
  const q = hub.qr.get(ws);
  if (!q) return null;
  if (q.expiresAt < Date.now()) {
    hub.qr.delete(ws);
    return null;
  }
  return q.qr;
}
