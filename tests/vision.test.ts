import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadLlmConfig } from '../src/lib/config';
import { FixtureModelProvider } from '../src/fixtures/model';
import { loadFixtureBundle } from '../src/fixtures/source';
import { dispatchOutbox, runJob } from '../src/server/ai/pipeline';
import type { CompletionRequest, CompletionResult, ModelProvider, Role } from '../src/server/ai/provider';
import { ingestEvents, tombstoneMessage, type IngestContext } from '../src/server/ingest/ingest';
import type { MessageEvent, NormalizedAttachment } from '../src/server/ingest/types';
import { getStorage } from '../src/server/storage';
import { applySelections, ensureLinkedAccount, ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

class Recording implements ModelProvider {
  readonly kind = 'fixture' as const;
  requests: CompletionRequest[] = [];
  constructor(private inner: FixtureModelProvider) {}
  modelIdFor(r: Role) {
    return this.inner.modelIdFor(r);
  }
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    return this.inner.complete(req);
  }
}

let t: TestDb;
let dir: string;
let ctx: IngestContext;
const cfg = { ...loadLlmConfig({}), LLM_PROVIDER: 'fixture' as const, LLM_MICROBATCH_MAX_WAIT_MS: 0 };
const JID = '120363000000000777@g.us';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG_THUMB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 2)]).toString('base64');
let n = 0;
const media = (att: Partial<NormalizedAttachment> & Pick<NormalizedAttachment, 'mediaType'>, caption: string | null): MessageEvent => ({
  type: 'message', origin: 'live', chatJid: JID, chatKind: 'group', nativeId: `v${++n}`, fromMe: false, participantJid: '6511@s.whatsapp.net', participantAltJid: null,
  senderJid: '6511@s.whatsapp.net', senderName: 'Kai', sentAtSec: 1_760_000_000 + n, kind: 'media', body: caption, replyToNativeId: null, ephemeralSec: null, marker: null,
  attachments: [{ mime: att.mediaType === 'video' ? 'video/mp4' : 'image/png', filename: null, size: 100, viewOnce: false, mediaRef: null, ...att }],
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-vision-'));
  process.env.STORAGE_DRIVER = 'local';
  process.env.LOCAL_STORAGE_DIR = dir;
  t = await createTestDb();
  const ws = await ensurePrivateWorkspace(t.db, await createUser(t.db));
  const la = await ensureLinkedAccount(t.db, ws.id);
  ctx = { workspaceId: ws.id, linkedAccountId: la.id, sourceKind: 'whatsapp', historyCapPerChat: 1000, storage: getStorage() };
  await ingestEvents(t.db, ctx, [{ type: 'chat_meta', chatJid: JID, kind: 'group', title: 'Class' }]);
  const [chat] = await t.db.select().from(s.chats).where(eq(s.chats.nativeJid, JID));
  await applySelections(t.db, ws.id, [{ chatId: chat.id, selected: true }]);
});
afterAll(async () => {
  await t?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const jobs = () => t.db.select().from(s.analysisJobs);

describe('images and video are understood by the vision model', () => {
  it('holds a batch while its image downloads, then describes the real image and feeds that to categorisation', async () => {
    await ingestEvents(t.db, ctx, [media({ mediaType: 'image', mediaRef: '{}', thumbnailB64: JPEG_THUMB }, null)]);
    const [att] = await t.db.select().from(s.attachments);
    expect(att.availability).toBe('available');
    expect(att.thumbnail).not.toBeNull(); // WhatsApp's preview kept at ingest
    await dispatchOutbox(t.db, cfg);
    expect(await jobs()).toHaveLength(0); // waiting for the download

    // The companion finishes the download.
    const key = `ws/${ctx.workspaceId}/att/${att.id}`;
    await getStorage().put(key, PNG, 'image/png');
    await t.db.update(s.attachments).set({ availability: 'cached', objectKey: key, detectedMime: 'image/png' }).where(eq(s.attachments.id, att.id));
    await dispatchOutbox(t.db, cfg);
    const [job] = await jobs();
    expect(job).toBeDefined();

    const provider = new Recording(new FixtureModelProvider(loadFixtureBundle().manifest));
    await runJob({ db: t.db, provider, cfg, sleep: async () => undefined }, job.id);
    const describe = provider.requests.find((r) => r.operation === 'describe');
    expect(describe?.role).toBe('vision');
    expect(describe?.images).toEqual([{ mime: 'image/png', b64: PNG.toString('base64') }]); // the full image, not the preview
    const extract = provider.requests.find((r) => r.operation === 'extract');
    expect(extract?.user).toContain('[image: A shared photo (fixture description).]');
    const [after] = await t.db.select().from(s.attachments).where(eq(s.attachments.id, att.id));
    expect(after.aiDescription).toBe('A shared photo (fixture description).');
    expect(after.aiDescribedBy).toBe('fixture-vision');
  });

  it('reads a video from its preview frame, and revoking the message erases preview and description', async () => {
    await t.db.update(s.analysisJobs).set({ status: 'completed' });
    await ingestEvents(t.db, ctx, [media({ mediaType: 'video', thumbnailB64: JPEG_THUMB }, 'our demo run')]);
    await dispatchOutbox(t.db, cfg);
    const job = (await jobs()).find((j) => j.status === 'pending')!;
    const provider = new Recording(new FixtureModelProvider(loadFixtureBundle().manifest));
    await runJob({ db: t.db, provider, cfg, sleep: async () => undefined }, job.id);
    const describe = provider.requests.find((r) => r.operation === 'describe');
    expect(describe?.images).toEqual([{ mime: 'image/jpeg', b64: JPEG_THUMB }]);
    expect(JSON.parse(describe!.user)).toEqual({ kind: 'video', caption: 'our demo run' });

    const [video] = await t.db.select().from(s.attachments).where(eq(s.attachments.mediaType, 'video'));
    expect(video.aiDescription).not.toBeNull();
    await t.db.transaction((tx) => tombstoneMessage(tx, ctx, video.messageId, 'revoked'));
    const [gone] = await t.db.select().from(s.attachments).where(eq(s.attachments.id, video.id));
    expect(gone.thumbnail).toBeNull();
    expect(gone.aiDescription).toBeNull();
  });
});
