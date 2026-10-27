import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { startPairing } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let ctx: AuthCtx;
beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  ctx = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
});
afterAll(async () => t?.close());

const payloadOf = async (id: string) => (await t.db.select().from(s.connectorCommands).where(eq(s.connectorCommands.id, id)))[0].payload;

describe('linking WhatsApp', () => {
  it('links by QR by default and by phone number when one is given (digits only, country code included)', async () => {
    expect(await payloadOf((await startPairing(t.db, ctx)).attempt_id)).toEqual({});
    expect(await payloadOf((await startPairing(t.db, ctx, { phone: '+65 9123-4567' })).attempt_id)).toEqual({ phone: '6591234567' });
  });

  it('rejects numbers that cannot be a full international number', async () => {
    await expect(startPairing(t.db, ctx, { phone: '9123' })).rejects.toThrow(/country code/);
    await expect(startPairing(t.db, ctx, { phone: 'abc12345678' })).rejects.toThrow(/country code/);
    await expect(startPairing(t.db, { ...ctx, mode: 'demo' }, { phone: '6591234567' })).rejects.toThrow(/demo/);
  });
});
