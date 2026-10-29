// A pg LISTEN connection that heals itself. A pooled or remote connection (e.g. Supabase's
// session pooler) can be dropped without the client ever seeing an error; LISTEN then goes
// silent for good. So: TCP keepalive, a ping every 30 s, and on any failure reconnect.
import pg from 'pg';
import { pgSslOptions } from './db';

const PING_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const RETRY_MS = 2_000;

export interface ListenOpts {
  url: string | undefined;
  application: string;
  channels: string[];
  onNotification: (n: pg.Notification) => void;
  /** Called after every (re)connect, e.g. to catch up on anything missed while down. */
  onConnect?: () => void;
}

/** Resolves once the first connection is listening; keeps reconnecting until stopped. */
export function listenForever(opts: ListenOpts): Promise<() => void> {
  let stopped = false;
  let client: pg.Client | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let first: ((stop: () => void) => void) | undefined;
  let firstFail: ((e: unknown) => void) | undefined;
  const ready = new Promise<() => void>((res, rej) => ((first = res), (firstFail = rej)));

  const stop = () => {
    stopped = true;
    clearInterval(ping);
    void client?.end().catch(() => undefined);
  };

  const drop = (c: pg.Client) => {
    if (client !== c) return; // already replaced
    client = undefined;
    clearInterval(ping);
    void c.end().catch(() => undefined);
    if (!stopped) setTimeout(connect, RETRY_MS);
  };

  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: opts.url, ssl: pgSslOptions(), application_name: opts.application, keepAlive: true });
    client = c;
    c.on('error', () => drop(c));
    c.on('end', () => drop(c));
    c.on('notification', opts.onNotification);
    try {
      await c.connect();
      for (const ch of opts.channels) await c.query(`LISTEN ${ch}`);
    } catch (e) {
      if (first) {
        // The first attempt fails loudly, like a plain client would.
        firstFail?.(e);
        first = firstFail = undefined;
        stopped = true;
        void c.end().catch(() => undefined);
        return;
      }
      drop(c);
      return;
    }
    ping = setInterval(() => {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), PING_TIMEOUT_MS));
      Promise.race([c.query('SELECT 1'), timeout]).catch(() => drop(c));
    }, PING_MS);
    opts.onConnect?.();
    first?.(stop);
    first = firstFail = undefined;
  };

  void connect();
  return ready;
}
