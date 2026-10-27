import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db';

export const EVENTS_CHANNEL = 'tm_events';
export const QR_CHANNEL = 'tm_qr';
// Ask: the web process hands a question to the worker (which alone holds the model key) and awaits the reply.
export const ASK_CHANNEL = 'tm_ask';
export const ASK_REPLY_CHANNEL = 'tm_ask_reply';

/** Content-free change notifications delivered (on commit) to SSE subscribers. */
export interface ChangeEvent {
  ws: string;
  kind: 'source' | 'graph' | 'review' | 'connection' | 'chats' | 'analysis' | 'media';
  chatId?: string;
  version?: number;
  userId?: string;
}

/** pg_notify inside a transaction is delivered only if the transaction commits. */
export async function notifyChange(db: DbOrTx, ev: ChangeEvent): Promise<void> {
  await db.execute(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(ev)})`);
}
