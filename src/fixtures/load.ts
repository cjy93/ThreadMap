// Load the synthetic fixture chats into a workspace and analyze them with the
// FixtureModelProvider. Used by tests, the isolated public demo and local dev.
import { and, eq, inArray } from 'drizzle-orm';
import * as s from '../db/schema';
import type { LlmConfig } from '../lib/config';
import { loadLlmConfig } from '../lib/config';
import { drainJobs } from '../server/ai/drain';
import type { RouterDeps } from '../server/ai/router';
import type { Db } from '../server/db';
import type { IngestContext } from '../server/ingest/ingest';
import type { StorageAdapter } from '../server/storage';
import { applySelections } from '../server/workspace';
import { FixtureModelProvider } from './model';
import { loadFixtureBundle, replayFixtureStep, type FixtureBundle } from './source';

export function fixtureLlmConfig(): LlmConfig {
  return { ...loadLlmConfig({}), LLM_PROVIDER: 'fixture', LLM_MAX_CALLS_PER_JOB: 500, LLM_MAX_USD_PER_JOB: 1, LLM_MAX_USD_PER_DAY: 5 };
}

export function fixtureContext(workspaceId: string, storage?: StorageAdapter): IngestContext {
  return { workspaceId, linkedAccountId: null, sourceKind: 'fixture', historyCapPerChat: 10_000, storage };
}

export async function loadFixtureWorkspace(
  db: Db,
  workspaceId: string,
  opts: { storage?: StorageAdapter; analyze?: boolean; bundle?: FixtureBundle; onCall?: RouterDeps['onCall'] } = {},
) {
  const bundle = opts.bundle ?? loadFixtureBundle();
  const ctx = fixtureContext(workspaceId, opts.storage);
  await replayFixtureStep(db, ctx, 'discover', bundle);
  const jids = Object.values(bundle.manifest.chats).map((c) => c.jid);
  const chats = await db.select().from(s.chats).where(and(eq(s.chats.workspaceId, workspaceId), inArray(s.chats.nativeJid, jids)));
  await applySelections(db, workspaceId, chats.map((c) => ({ chatId: c.id, selected: true, historyMode: 'available_history' as const })));
  const stats = await replayFixtureStep(db, ctx, 'initial', bundle);
  const chatIdByKey = Object.fromEntries(
    Object.entries(bundle.manifest.chats).map(([k, c]) => [k, chats.find((x) => x.nativeJid === c.jid)!.id]),
  ) as Record<'builders' | 'study' | 'music', string>;
  if (opts.analyze !== false) {
    const provider = new FixtureModelProvider(bundle.manifest);
    await drainJobs({ db, provider, cfg: fixtureLlmConfig(), sleep: async () => undefined, onCall: opts.onCall }, { chatIds: Object.values(chatIdByKey) });
  }
  return { stats, chatIdByKey, ctx, bundle };
}
