import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadLlmConfig } from '../src/lib/config';
import { dispatchOutbox } from '../src/server/ai/pipeline';
import { refreshChat } from '../src/server/api/connector';
import type { AuthCtx } from '../src/server/api/service';
import { ingestEvents, type IngestContext } from '../src/server/ingest/ingest';
import type { MessageEvent } from '../src/server/ingest/types';
import { applySelections, ensureLinkedAccount, ensurePrivateWorkspace, FIRST_OPEN_ANALYSIS_MS } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

let t: TestDb;
let ctx: IngestContext;
let auth: AuthCtx;
const cfg = { ...loadLlmConfig({}), LLM_MICROBATCH_MAX_WAIT_MS: 0 };
const JID = '6512340000@s.whatsapp.net';
let n = 0;
const msg = (): MessageEvent => ({
  type: 'message', origin: 'live', chatJid: JID, chatKind: 'direct', nativeId: `m${++n}`, fromMe: false, participantJid: null, participantAltJid: null,
  senderJid: JID, senderName: 'Ali', sentAtSec: 1_760_000_000 + n, kind: 'text', body: `hello ${n}`, attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null,
});

beforeAll(async () => {
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const la = await ensureLinkedAccount(t.db, ws.id);
  ctx = { workspaceId: ws.id, linkedAccountId: la.id, sourceKind: 'whatsapp', historyCapPerChat: 1000 };
  auth = { userId: ws.ownerUserId, workspaceId: ws.id, mode: 'private' };
});
afterAll(async () => t?.close());

const chat = async () => (await t.db.select().from(s.chats).where(eq(s.chats.nativeJid, JID)))[0];
const jobs = async () => (await t.db.select().from(s.analysisJobs).where(eq(s.analysisJobs.kind, 'microbatch'))).length;
// Stands in for the worker running queued jobs to completion.
const finishJobs = () => t.db.update(s.analysisJobs).set({ status: 'completed' }).where(eq(s.analysisJobs.status, 'pending'));
const waiting = async () => (await t.db.select().from(s.analysisOutbox)).filter((o) => !o.dispatchedJobId).length;

describe('Nemotron runs on open and on Refresh only', () => {
  it('analyses a chat right after it is first opened', async () => {
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: JID, kind: 'direct', title: 'Ali' }]);
    const before = Date.now();
    await applySelections(t.db, ctx.workspaceId, [{ chatId: (await chat()).id, selected: true }]);
    const c = await chat();
    expect(c.autoAnalyzeUntil!.getTime()).toBeGreaterThanOrEqual(before + FIRST_OPEN_ANALYSIS_MS - 1000);
    await ingestEvents(t.db, ctx, [msg(), msg()]); // history arriving
    await dispatchOutbox(t.db, cfg);
    expect(await jobs()).toBe(1);
    expect(await waiting()).toBe(0);
  });

  it('lets later messages wait, without calling Nemotron, until Refresh', async () => {
    await t.db.update(s.chats).set({ autoAnalyzeUntil: new Date(Date.now() - 1000) }).where(eq(s.chats.nativeJid, JID));
    await ingestEvents(t.db, ctx, [msg(), msg(), msg()]);
    await dispatchOutbox(t.db, cfg);
    expect(await jobs()).toBe(1); // no new job
    expect(await waiting()).toBe(3);

    await finishJobs();
    const r = await refreshChat(t.db, auth, (await chat()).id);
    expect(r.analysing).toBe(3);
    await dispatchOutbox(t.db, cfg);
    expect(await jobs()).toBe(2);
    expect(await waiting()).toBe(0);
    await finishJobs();
    // Nothing new: Refresh says so and does not open the window.
    await t.db.update(s.chats).set({ autoAnalyzeUntil: new Date(Date.now() - 1000) }).where(eq(s.chats.nativeJid, JID));
    expect(await refreshChat(t.db, auth, (await chat()).id)).toMatchObject({ analysing: 0, note: 'Already up to date.' });
    expect((await chat()).autoAnalyzeUntil!.getTime()).toBeLessThan(Date.now());
  });

  it('re-queues messages whose analysis was cancelled, so Refresh can still map them', async () => {
    await t.db.update(s.chats).set({ autoAnalyzeUntil: new Date(Date.now() - 1000) }).where(eq(s.chats.nativeJid, JID));
    await ingestEvents(t.db, ctx, [msg(), msg()]);
    await refreshChat(t.db, auth, (await chat()).id);
    await dispatchOutbox(t.db, cfg);
    // The job is cancelled before it runs (as when a selection changed while it was queued).
    await t.db.update(s.analysisJobs).set({ status: 'cancelled' }).where(eq(s.analysisJobs.status, 'pending'));
    expect(await waiting()).toBe(0);
    const r = await refreshChat(t.db, auth, (await chat()).id);
    // Exactly the messages of the cancelled job are queued again; finished jobs are left alone.
    expect(r.analysing).toBe(2);
    expect(await waiting()).toBe(r.analysing);
  });

  it('refuses Refresh for chats that were never opened and for demo guests', async () => {
    await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: '6599990000@s.whatsapp.net', kind: 'direct', title: 'Never opened' }]);
    const [other] = await t.db.select().from(s.chats).where(eq(s.chats.nativeJid, '6599990000@s.whatsapp.net'));
    await expect(refreshChat(t.db, auth, other.id)).rejects.toThrow(/open this chat first/);
    await expect(refreshChat(t.db, { ...auth, mode: 'demo' }, (await chat()).id)).rejects.toThrow(/demo/);
  });
});
