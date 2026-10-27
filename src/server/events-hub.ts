// Web-process fan-out of committed change notifications (pg LISTEN) to
// authenticated SSE subscribers, scoped by workspace. QR payloads are kept only
// in bounded memory until expiry and are surfaced only to the owner workspace.
import pg from 'pg';
import { pgSslOptions } from './db';
import { ASK_REPLY_CHANNEL, EVENTS_CHANNEL, QR_CHANNEL, type ChangeEvent } from './notify';

type Listener = (ev: { type: string; data: unknown }) => void;

interface Hub {
  subs: Map<string, Set<Listener>>;
  qr: Map<string, { qr: string; expiresAt: number }>;
  // Phone-number pairing codes, like QR payloads: owner-only, memory-only, short-lived.
  codes?: Map<string, { code: string; expiresAt: number }>;
  // Pending Ask requests awaiting the worker's reply, by request id.
  asks?: Map<string, (reply: unknown) => void>;
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
    await client.query(`LISTEN ${ASK_REPLY_CHANNEL}`);
    client.on('notification', (n) => {
      try {
        const payload = JSON.parse(n.payload ?? '{}');
        if (n.channel === ASK_REPLY_CHANNEL) {
          const { id, ok, ...rest } = payload as { id: string; ok: boolean };
          hub.asks?.get(id)?.(ok ? rest : null);
          return;
        }
        if (n.channel === QR_CHANNEL) {
          const { ws, qr, code, ttlMs } = payload as { ws: string; qr: string | null; code?: string; ttlMs?: number };
          hub.codes ??= new Map();
          if (code) hub.codes.set(ws, { code, expiresAt: Date.now() + Math.min(ttlMs ?? 180_000, 300_000) });
          else if (!qr) hub.codes.delete(ws);
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

/** Register for the worker's answer to an Ask request before sending it; resolves null on timeout. */
export async function prepareAskReply(id: string, timeoutMs: number): Promise<{ reply: Promise<unknown> }> {
  await start();
  hub.asks ??= new Map();
  const asks = hub.asks;
  // Wrapped: an async function returning a bare promise would wait for the reply itself.
  const reply = new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => {
      asks.delete(id);
      resolve(null);
    }, timeoutMs);
    asks.set(id, (reply) => {
      clearTimeout(timer);
      asks.delete(id);
      resolve(reply);
    });
  });
  return { reply };
}

export function currentPairingCode(ws: string): string | null {
  const c = hub.codes?.get(ws);
  if (!c) return null;
  if (c.expiresAt < Date.now()) {
    hub.codes!.delete(ws);
    return null;
  }
  return c.code;
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
