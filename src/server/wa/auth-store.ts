// Encrypted PostgreSQL AuthStateStore for Baileys: credentials AND Signal key
// updates are sealed with AES-256-GCM (key from SecretStash) and bound to the
// account/category/id via AAD. Writes are fenced by the account lease.
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap } from 'baileys';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import { open, seal } from '../crypto';
import type { Db, Tx } from '../db';

export type Fence = (tx: Tx) => Promise<void>;

const aad = (accountId: string, category: string, id: string) => `${accountId}|${category}|${id}`;

export async function loadPgAuthState(db: Db, linkedAccountId: string, key: Buffer, keyVersion: number, fence: Fence) {
  const read = async (category: string, ids: string[]) => {
    if (!ids.length) return new Map<string, unknown>();
    const rows = await db
      .select()
      .from(s.authRecords)
      .where(and(eq(s.authRecords.linkedAccountId, linkedAccountId), eq(s.authRecords.category, category), inArray(s.authRecords.recordId, ids)));
    const out = new Map<string, unknown>();
    for (const r of rows) {
      const plain = open(key, { iv: r.iv, tag: r.tag, ciphertext: r.ciphertext }, aad(linkedAccountId, category, r.recordId));
      out.set(r.recordId, JSON.parse(plain.toString('utf8'), BufferJSON.reviver));
    }
    return out;
  };

  const writeMany = async (entries: { category: string; id: string; value: unknown | null }[]) => {
    await db.transaction(async (tx) => {
      await fence(tx);
      for (const e of entries) {
        if (e.value === null || e.value === undefined) {
          await tx.delete(s.authRecords).where(and(eq(s.authRecords.linkedAccountId, linkedAccountId), eq(s.authRecords.category, e.category), eq(s.authRecords.recordId, e.id)));
          continue;
        }
        const sealed = seal(key, Buffer.from(JSON.stringify(e.value, BufferJSON.replacer), 'utf8'), aad(linkedAccountId, e.category, e.id));
        await tx
          .insert(s.authRecords)
          .values({ linkedAccountId, category: e.category, recordId: e.id, keyVersion, ...sealed })
          .onConflictDoUpdate({
            target: [s.authRecords.linkedAccountId, s.authRecords.category, s.authRecords.recordId],
            set: { keyVersion, iv: sealed.iv, tag: sealed.tag, ciphertext: sealed.ciphertext, updatedAt: sql`now()` },
          });
      }
    });
  };

  const existing = (await read('creds', ['creds'])).get('creds') as AuthenticationCreds | undefined;
  const creds: AuthenticationCreds = existing ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const m = await read(type, ids);
        const data: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let v = m.get(id);
          if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v as object);
          if (v !== undefined) data[id] = v as SignalDataTypeMap[T];
        }
        return data;
      },
      set: async (data: SignalDataSet) => {
        const entries: { category: string; id: string; value: unknown | null }[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
          for (const [id, value] of Object.entries(data[category] ?? {})) entries.push({ category, id, value: value ?? null });
        }
        await writeMany(entries);
      },
    },
  };

  return {
    state,
    hasStoredCreds: Boolean(existing),
    saveCreds: () => writeMany([{ category: 'creds', id: 'creds', value: state.creds }]),
  };
}

/** Remove all saved credentials and Signal keys for an account (disconnect/unlink). */
export async function clearAuthState(db: Db, linkedAccountId: string) {
  await db.delete(s.authRecords).where(eq(s.authRecords.linkedAccountId, linkedAccountId));
}
