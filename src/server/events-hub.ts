// Web-process fan-out of committed change notifications (pg LISTEN) to
// authenticated SSE subscribers, scoped by workspace. QR payloads are kept only
// in bounded memory until expiry and are surfaced only to the owner workspace.
import type pg from 'pg';
import { listenForever } from './listen';
import { ASK_REPLY_CHANNEL, EVENTS_CHANNEL, QR_CHANNEL, type ChangeEvent } from './notify';

type Listener = (ev: { type: string; data: unknown }) => void;

/** The worker's reply to an Ask-channel request: its result, or why it could not answer. */
export type WorkerReply = ({ ok: true } & Record<string, unknown>) | { ok: false; reason: string };
export interface LateReply {
  ws: string;
  kind: string;
  state: 'pending' | 'done' | 'failed';
  reply?: Record<string, unknown>;
  reason?: string;
  expiresAt: number;
}
const LATE_KEEP_MS = 10 * 60_000;

interface Hub {
  subs: Map<string, Set<Listener>>;
  qr: Map<string, { qr: string; expiresAt: number }>;
  // Phone-number pairing codes, like QR payloads: owner-only, memory-only, short-lived.
  codes?: Map<string, { code: string; expiresAt: number }>;
  // Pending Ask requests awaiting the worker's reply, by request id.
  asks?: Map<string, (reply: WorkerReply) => void>;
  // Replies still on their way when the web request stopped waiting: the worker carries on, and
  // the page collects the result here a little later (owner workspace only, kept briefly).
  late?: Map<string, LateReply>;
  // The self-healing LISTEN connection, once started.
  listening?: Promise<unknown>;
}

const g = globalThis as unknown as { __tmHub?: Hub };
const hub: Hub = (g.__tmHub ??= { subs: new Map(), qr: new Map() });

function emit(ws: string, ev: { type: string; data: unknown }) {
  for (const l of hub.subs.get(ws) ?? []) l(ev);
}

function onNotification(n: pg.Notification) {
  try {
    const payload = JSON.parse(n.payload ?? '{}');
    if (n.channel === ASK_REPLY_CHANNEL) {
      const { id, ...rest } = payload as { id: string } & WorkerReply;
      hub.asks?.get(id)?.(rest as WorkerReply);
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
}

async function start(): Promise<void> {
  hub.listening ??= listenForever({
    url: process.env.DATABASE_URL,
    application: 'threadmap-web-listen',
    channels: [EVENTS_CHANNEL, QR_CHANNEL, ASK_REPLY_CHANNEL],
    onNotification,
  }).catch((e: unknown) => {
    hub.listening = undefined;
    throw e;
  });
  await hub.listening;
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

/**
 * Register for the worker's answer to an Ask request before sending it. Resolves with
 * the reply, or null on timeout; a reply arriving after the timeout is kept for
 * `lateAskReply` (the worker does not stop because the page stopped waiting).
 */
export async function prepareAskReply(id: string, timeoutMs: number, meta: { ws: string; kind: string }): Promise<{ reply: Promise<WorkerReply | null> }> {
  await start();
  hub.asks ??= new Map();
  hub.late ??= new Map();
  const asks = hub.asks;
  const late = hub.late;
  for (const [k, v] of late) if (v.expiresAt < Date.now()) late.delete(k);
  // Wrapped: an async function returning a bare promise would wait for the reply itself.
  const reply = new Promise<WorkerReply | null>((resolve) => {
    const timer = setTimeout(() => {
      late.set(id, { ...meta, state: 'pending', expiresAt: Date.now() + LATE_KEEP_MS });
      asks.set(id, (r) => {
        asks.delete(id);
        late.set(id, r.ok ? { ...meta, state: 'done', reply: r, expiresAt: Date.now() + LATE_KEEP_MS } : { ...meta, state: 'failed', reason: r.reason, expiresAt: Date.now() + LATE_KEEP_MS });
      });
      // Give up on a reply that never comes.
      setTimeout(() => asks.delete(id), LATE_KEEP_MS).unref?.();
      resolve(null);
    }, timeoutMs);
    asks.set(id, (r) => {
      clearTimeout(timer);
      asks.delete(id);
      resolve(r);
    });
  });
  return { reply };
}

/** A reply that came (or is still coming) after its request stopped waiting; only for its own workspace. */
export function lateAskReply(id: string, ws: string): LateReply | null {
  const r = hub.late?.get(id);
  return r && r.ws === ws && r.expiresAt > Date.now() ? r : null;
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
