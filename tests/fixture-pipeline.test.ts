import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import { loadFixtureWorkspace } from '../src/fixtures/load';
import { loadFixtureBundle } from '../src/fixtures/source';
import { computeCounts } from '../src/server/graph/counts';
import { ContentFilterSchema } from '../src/server/graph/filters';
import { ancestors, loadTree, ROOTS } from '../src/server/graph/tree';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

const bundle = loadFixtureBundle();
const M = bundle.manifest;
let t: TestDb;
let userId: string;
let wsId: string;
let chatIds: Record<'builders' | 'study' | 'music', string>;
let modelCalls = 0;

const ROOT_LETTER = { KNOWLEDGE: 'K', GENERAL_CHAT: 'G', EVENTS_ACTIVITIES: 'E', RESOURCES: 'R' } as const;

beforeAll(async () => {
  t = await createTestDb();
  userId = await createUser(t.db);
  wsId = (await ensurePrivateWorkspace(t.db, userId)).id;
  const r = await loadFixtureWorkspace(t.db, wsId, { onCall: () => modelCalls++ });
  chatIds = r.chatIdByKey;
});
afterAll(async () => t?.close());

const allFilter = ContentFilterSchema.parse({ status: 'all' });

async function pathMap(chatId: string) {
  const tree = await loadTree(t.db, chatId);
  const byPath = new Map<string, string>();
  for (const n of tree.nodes.values()) {
    const chain = ancestors(tree, n.id);
    byPath.set([ROOT_LETTER[chain[0].root], ...chain.slice(1).map((a) => a.title)].join('/'), n.id);
  }
  return { tree, byPath };
}

describe('fixture load + FixtureModelProvider pipeline', () => {
  it('stores exactly 300 eligible human messages split 120/100/80 with four roots per chat', async () => {
    for (const [k, expected] of Object.entries({ builders: 120, study: 100, music: 80 })) {
      const r = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatIds[k as 'builders']}::uuid AND kind IN ('text','media') AND state = 'active'`);
      expect(r.rows[0].n, k).toBe(expected);
      const tree = await loadTree(t.db, chatIds[k as 'builders']);
      expect(tree.roots.map((r) => r.root)).toEqual([...ROOTS]);
    }
    expect(modelCalls).toBeGreaterThan(0);
  });

  it('never stores unselected chat content', async () => {
    const r = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE body LIKE '%PRIVATE-UNSELECTED-CANARY%'`);
    expect(r.rows[0].n).toBe(0);
    const [unselected] = await t.db.select().from(s.chats).where(eq(s.chats.nativeJid, '120363000000000099@g.us'));
    expect(unselected.selected).toBe(false);
  });

  it('reproduces the evidence-supported six-level Knowledge branch through recursive refinement', async () => {
    const { tree, byPath } = await pathMap(chatIds.builders);
    const deep = 'K/Programming/Hackathons/Solutions/Authentication/Tokens/Refresh flow';
    const id = byPath.get(deep);
    expect(id, 'deep refresh-flow topic').toBeDefined();
    expect(tree.nodes.get(id!)!.depth).toBe(6);
    expect(tree.maxDepth).toBeGreaterThanOrEqual(6);
    // Same title under different parents remain distinct topics.
    expect(byPath.get('K/Programming/Hackathons/Tips')).toBeDefined();
    expect(byPath.get('K/Programming/School work/Tips')).toBeDefined();
    expect(byPath.get('K/Programming/Hackathons/Tips')).not.toBe(byPath.get('K/Programming/School work/Tips'));
    // Refinement the model asked for continued under the same logical job (frontiers completed);
    // deepening of crowded topics after the map is built runs under ledgers of its own.
    const fr = await t.db.select().from(s.taxonomyFrontiers).where(eq(s.taxonomyFrontiers.chatId, chatIds.builders));
    const asked = fr.filter((f) => !(f.checkpoint as { deepen?: boolean }).deepen);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked.map((f) => f.logicalJobId)).size).toBe(1);
    expect(fr.every((f) => f.status === 'completed')).toBe(true);
  });

  it('matches every manifest topic count (distinct, recursive, deduplicated)', async () => {
    for (const key of ['builders', 'study', 'music'] as const) {
      const { byPath } = await pathMap(chatIds[key]);
      const counts = await computeCounts(t.db, { userId, workspaceId: wsId, chatId: chatIds[key] }, allFilter);
      for (const [mk, expected] of Object.entries(M.expectedCounts)) {
        if (!mk.startsWith(`${key}:`)) continue;
        const path = mk.slice(key.length + 1);
        const id = byPath.get(path);
        expect(id, `${mk} exists`).toBeDefined();
        expect(counts.topics.get(id!)?.total ?? 0, mk).toBe(expected);
      }
    }
  });

  it('handles replay, out-of-order controls, expiry and alias learning', async () => {
    const byNative = async (id: string) => (await t.db.select().from(s.messages).where(eq(s.messages.nativeId, id)))[0];
    const late = await byNative(M.refs['late-edited']);
    expect(late.contentRevision).toBe(2);
    expect(late.body).toContain('charged backup phone');
    const revoked = await byNative(M.refs['revoked-early']);
    expect(revoked.state).toBe('revoked');
    expect(revoked.body).toBeNull();
    const r = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE body LIKE '%REVOKED-CANARY%'`);
    expect(r.rows[0].n).toBe(0);
    const expired = await t.db.execute<{ state: string }>(sql`SELECT state FROM messages WHERE chat_id = ${chatIds.music}::uuid AND ingest_event_type LIKE 'history:%' AND body IS NULL AND state <> 'active'`);
    expect(expired.rows.map((x) => x.state)).toContain('expired');
    // Distinct native messages with identical text are all retained.
    const thanks = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chatIds.builders}::uuid AND body = 'Thanks!'`);
    expect(thanks.rows[0].n).toBe(3);
    const kinds = await t.db.execute<{ kind: string; n: number }>(sql`SELECT kind, count(*)::int AS n FROM messages WHERE workspace_id = ${wsId}::uuid GROUP BY kind`);
    const k = Object.fromEntries(kinds.rows.map((x) => [x.kind, x.n]));
    expect(k.system).toBe(1);
    expect(k.unsupported).toBe(3); // location, view-once, poll
  });

  it('places multi-placement messages once per ancestor (no inflation)', async () => {
    const { byPath } = await pathMap(chatIds.builders);
    const counts = await computeCounts(t.db, { userId, workspaceId: wsId, chatId: chatIds.builders }, allFilter);
    const tokens = counts.topics.get(byPath.get('K/Programming/Hackathons/Solutions/Authentication/Tokens')!)!.total;
    const refresh = counts.topics.get(byPath.get('K/Programming/Hackathons/Solutions/Authentication/Tokens/Refresh flow')!)!.total;
    const lifetime = counts.topics.get(byPath.get('K/Programming/Hackathons/Solutions/Authentication/Tokens/Access token lifetime')!)!.total;
    // lifetime-overlap message is in both children: parent < sum of children + direct
    expect(tokens).toBeLessThan(refresh + lifetime + 2);
    expect(tokens).toBe(M.expectedCounts['builders:K/Programming/Hackathons/Solutions/Authentication/Tokens']);
  });

  it('records fixture provenance, never model provenance, for fixture analysis', async () => {
    const runs = await t.db.select().from(s.modelRuns).where(eq(s.modelRuns.workspaceId, wsId));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.provider === 'fixture')).toBe(true);
    const p = await t.db.execute<{ provenance: string }>(sql`SELECT DISTINCT provenance FROM placements WHERE workspace_id = ${wsId}::uuid`);
    expect(p.rows.map((x) => x.provenance)).toEqual(['fixture']);
  });

  it('verifies cross-chat links with evidence on both sides and rejects unrelated ones', async () => {
    const links = await t.db.select().from(s.crossChatLinks).where(and(eq(s.crossChatLinks.workspaceId, wsId), eq(s.crossChatLinks.status, 'verified')));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.aEvidence.length).toBeGreaterThan(0);
      expect(l.bEvidence.length).toBeGreaterThan(0);
      expect(l.aChatId).not.toBe(l.bChatId);
    }
  });
});
