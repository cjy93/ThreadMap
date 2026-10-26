import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema';
import type { NativeEvent } from '../src/fixtures/generate';
import { fixtureContext, loadFixtureWorkspace } from '../src/fixtures/load';
import { loadFixtureBundle, replayFixtureStep } from '../src/fixtures/source';
import {
  bulkExecute,
  bulkPreview,
  getMap,
  getMessage,
  getNodeContent,
  patchTopic,
  putViewPreferences,
  related,
  resourcesFor,
  reviewOne,
  search,
  type AuthCtx,
} from '../src/server/api/service';
import { ancestors, loadTree } from '../src/server/graph/tree';
import { createLocalStorage } from '../src/server/storage';
import { ensurePrivateWorkspace } from '../src/server/workspace';
import { createTestDb, createUser, type TestDb } from './helpers/db';

const bundle = loadFixtureBundle();
const M = bundle.manifest;
let t: TestDb;
let ctx: AuthCtx;
let other: AuthCtx;
let chats: Record<'builders' | 'study' | 'music', string>;
const LETTER = { KNOWLEDGE: 'K', GENERAL_CHAT: 'G', RESOURCES: 'R' } as const;

beforeAll(async () => {
  t = await createTestDb();
  const u = await createUser(t.db);
  const ws = await ensurePrivateWorkspace(t.db, u);
  ctx = { userId: u, workspaceId: ws.id, mode: 'private' };
  chats = (await loadFixtureWorkspace(t.db, ws.id, { storage: createLocalStorage(path.join(os.tmpdir(), `tm-objects-${ws.id}`)) })).chatIdByKey;
  const u2 = await createUser(t.db);
  const ws2 = await ensurePrivateWorkspace(t.db, u2);
  other = { userId: u2, workspaceId: ws2.id, mode: 'private' };
});
afterAll(async () => t?.close());

const P = (o: Record<string, string>) => new URLSearchParams(o);

async function ids(chat: 'builders' | 'study' | 'music') {
  const tree = await loadTree(t.db, chats[chat]);
  const m = new Map<string, string>();
  for (const n of tree.nodes.values()) {
    const ch = ancestors(tree, n.id);
    m.set([LETTER[ch[0].root], ...ch.slice(1).map((a) => a.title)].join('/'), n.id);
  }
  return m;
}

async function allContentIds(chatId: string, nodeId: string, filter: Record<string, string>, tab: 'messages' | 'files' = 'messages') {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await getNodeContent(t.db, ctx, chatId, nodeId, P({ ...filter, tab, page_size: '7', ...(cursor ? { cursor } : {}) }));
    for (const it of r.items as { message_id?: string; attachment_id?: string }[]) out.push(tab === 'files' ? it.attachment_id! : it.message_id!);
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function modelRunCount() {
  const r = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM model_runs`);
  return r.rows[0].n;
}

const nativeToId = async (native: string) => (await t.db.select({ id: s.messages.id, rev: s.messages.contentRevision }).from(s.messages).where(eq(s.messages.nativeId, native)))[0];

describe('Show depth is display-only', () => {
  it('keeps matching sets, counts, logical sizes and bulk scopes identical at depths 0/1/2/6/All', async () => {
    const before = await modelRunCount();
    const p = await ids('builders');
    const knowledge = p.get('K')!;
    const programming = p.get('K/Programming')!;
    const snaps: { depth: string; counts: Record<string, number>; sizes: Record<string, number>; know: string[]; prog: string[]; bulk: number }[] = [];
    for (const depth of ['0', '1', '2', '6', 'all']) {
      const map = await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: depth }));
      expect(map.nodes.length).toBeLessThanOrEqual(200);
      const counts: Record<string, number> = {};
      const sizes: Record<string, number> = {};
      for (const n of map.nodes) {
        counts[n.id] = n.matching_message_count;
        sizes[n.id] = n.diameter!;
      }
      snaps.push({
        depth,
        counts,
        sizes,
        know: (await allContentIds(chats.builders, knowledge, { status: 'all' })).sort(),
        prog: (await allContentIds(chats.builders, programming, { status: 'all' })).sort(),
        bulk: (await bulkPreview(t.db, ctx, chats.builders, { node_id: knowledge, filter: { status: 'all' } })).count,
      });
      if (depth === '0') expect(map.nodes.every((n) => n.depth === 0)).toBe(true);
      if (depth === '6' || depth === 'all') expect(map.nodes.some((n) => n.depth === 6)).toBe(true);
    }
    for (const sn of snaps.slice(1)) {
      for (const id of Object.keys(snaps[0].counts)) {
        expect(sn.counts[id], `root count at depth ${sn.depth}`).toBe(snaps[0].counts[id]);
        expect(sn.sizes[id]).toBe(snaps[0].sizes[id]);
      }
      expect(sn.know).toEqual(snaps[0].know);
      expect(sn.prog).toEqual(snaps[0].prog);
      expect(sn.bulk).toBe(snaps[0].bulk);
    }
    // Content totals agree with map counts.
    expect(snaps[0].know.length).toBe(snaps[0].counts[knowledge]);
    // Navigation, depth, content and bulk preview make zero model calls.
    expect(await modelRunCount()).toBe(before);
  });

  it('opens a six-level-deep source and its file directly from Knowledge (depth 0) and Programming (depth 1)', async () => {
    const p = await ids('builders');
    const fileMsg = M.messages.find((m) => m.ref === 'refresh-file')!;
    const fileMsgId = (await nativeToId(fileMsg.nativeId)).id;
    for (const [depth, node] of [
      ['0', p.get('K')!],
      ['1', p.get('K/Programming')!],
    ] as const) {
      const map = await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: depth }));
      expect(map.nodes.find((n) => n.title === 'Refresh flow')).toBeUndefined();
      const msgs = await allContentIds(chats.builders, node, { status: 'all' });
      expect(msgs).toContain(fileMsgId);
      const files = await getNodeContent(t.db, ctx, chats.builders, node, P({ status: 'all', tab: 'files', page_size: '50' }));
      const f = (files.items as { filename: string; availability: string; topic_paths: { title: string }[][] }[]).find((x) => x.filename === 'refresh-flow-diagram.pdf');
      expect(f).toBeDefined();
      expect(f!.availability).toBe('cached');
      expect(f!.topic_paths[0].map((x) => x.title)).toEqual(['Knowledge', 'Programming', 'Hackathons', 'Solutions', 'Authentication', 'Tokens', 'Refresh flow']);
    }
    const msg = await getMessage(t.db, ctx, fileMsgId);
    expect(msg.sender).toBe('Wei Ming');
    expect(msg.sent_at).not.toBeNull();
    expect(msg.attachments[0].filename).toBe('refresh-flow-diagram.pdf');
  });

  it('reports available depth, treats larger requests as all, boundary indicators and hidden selected topics', async () => {
    const p = await ids('builders');
    const all = await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: 'all' }));
    const big = await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: '99' }));
    expect(all.available_max_topic_depth).toBe(6);
    expect(big.effective_depth).toBe(6);
    expect(big.nodes.map((n) => n.id).sort()).toEqual(all.nodes.map((n) => n.id).sort());
    const d1 = await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: '1' }));
    const prog = d1.nodes.find((n) => n.id === p.get('K/Programming'))!;
    expect(prog.boundary).toBe(true);
    expect(prog.has_deeper_topics).toBe(true);
    const deep = p.get('K/Programming/Hackathons/Solutions/Authentication/Tokens/Refresh flow')!;
    const hidden = await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: '1', topics: deep }));
    expect(hidden.hidden_selected_topics[0].id).toBe(deep);
    expect(hidden.hidden_selected_topics[0].visible_ancestor_id).toBe(p.get('K/Programming'));
    expect(hidden.hidden_selected_topics[0].path).toHaveLength(7);
    // Ancestor count under a hidden topic filter equals the deep topic's own count.
    const deepCount = all.nodes.find((n) => n.id === deep)!.matching_message_count;
    expect(hidden.nodes.find((n) => n.id === p.get('K'))!.matching_message_count).toBe(deepCount);
  });

  it('persists depth preference per user/chat with URL override and isolation', async () => {
    const first = await getMap(t.db, ctx, chats.study, P({}));
    expect(first.depth_source).toBe('default');
    expect(first.max_topic_depth).toBe(2);
    await putViewPreferences(t.db, ctx, chats.study, { show_depth: 3 });
    const saved = await getMap(t.db, ctx, chats.study, P({}));
    expect(saved.depth_source).toBe('preference');
    expect(saved.max_topic_depth).toBe(3);
    const url = await getMap(t.db, ctx, chats.study, P({ max_topic_depth: '0' }));
    expect(url.depth_source).toBe('url');
    expect(url.max_topic_depth).toBe(0);
    await expect(putViewPreferences(t.db, ctx, chats.study, { show_depth: -1 })).rejects.toThrow();
    await expect(putViewPreferences(t.db, ctx, chats.study, { show_depth: 'deep' })).rejects.toThrow();
    // Another user cannot read or write this chat's preferences.
    await expect(getMap(t.db, other, chats.study, P({}))).rejects.toThrow(/not found/);
    await expect(putViewPreferences(t.db, other, chats.study, { show_depth: 1 })).rejects.toThrow(/not found/);
  });
});

describe('combined content filters', () => {
  const times = new Map<string, number>();
  for (const e of bundle.steps.initial as NativeEvent[]) {
    const msgs = (e.data as { messages?: { key: { id: string }; messageTimestamp: number }[] }).messages ?? [];
    for (const m of msgs) times.set(m.key.id, m.messageTimestamp);
  }
  const from = Date.parse('2026-09-01T16:00:00Z') / 1000; // 2026-09-02 00:00 SGT
  const to = Date.parse('2026-09-03T16:00:00Z') / 1000; // 2026-09-04 00:00 SGT (exclusive)

  it.each([
    ['shallow', 'K/Programming'],
    ['deep', 'K/Programming/Hackathons/Solutions/Authentication/Tokens'],
  ])('Date + Topic + Missed agree across map, content, bulk, resources and search (%s)', async (_label, path) => {
    const p = await ids('builders');
    const topic = p.get(path)!;
    const expectedNative = M.messages
      .filter((m) => m.chat === 'builders' && m.phase !== 'update')
      .filter((m) => [m.topic, ...m.also].some((k) => k === `builders:${path}` || k.startsWith(`builders:${path}/`)))
      .filter((m) => times.get(m.nativeId)! >= from && times.get(m.nativeId)! < to)
      .map((m) => m.nativeId);
    const rows = await t.db.select({ id: s.messages.id, n: s.messages.nativeId }).from(s.messages).where(eq(s.messages.chatId, chats.builders));
    const idOf = new Map(rows.map((r) => [r.n, r.id]));
    const expected = expectedNative.map((n) => idOf.get(n)!).sort();
    expect(expected.length).toBeGreaterThan(0);
    const filter = { status: 'missed', from: '2026-09-02', to: '2026-09-03', tz: 'Asia/Singapore', topics: topic };
    const map = await getMap(t.db, ctx, chats.builders, P({ ...filter, max_topic_depth: '1' }));
    const knowledge = map.nodes.find((n) => n.id === p.get('K'))!;
    expect(knowledge.matching_message_count).toBe(expected.length);
    expect(knowledge.matching_missed_count).toBe(expected.length);
    expect((await allContentIds(chats.builders, p.get('K')!, filter)).sort()).toEqual(expected);
    expect((await allContentIds(chats.builders, topic, filter)).sort()).toEqual(expected);
    expect((await bulkPreview(t.db, ctx, chats.builders, { node_id: p.get('K'), filter })).count).toBe(expected.length);
    const res = await resourcesFor(t.db, ctx, chats.builders, P(filter));
    expect(res.message_ids.every((m) => expected.includes(m))).toBe(true);
    const sr = await search(t.db, ctx, P({ ...filter, q: 'token', chat: chats.builders }));
    expect(sr.results.every((r) => expected.includes(r.message_id))).toBe(true);
    const tokenHits = expected.filter((id) => {
      const nat = rows.find((r) => r.id === id)!.n;
      const m = M.messages.find((x) => x.nativeId === nat)!;
      return /token/i.test(m.text) || /token/i.test(m.speaker);
    });
    expect(sr.results.length).toBeGreaterThanOrEqual(tokenHits.length);
  });

  it('opening maps, content lists and messages never marks anything Read', async () => {
    const before = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM review_state`);
    const p = await ids('builders');
    await getMap(t.db, ctx, chats.builders, P({}));
    await getNodeContent(t.db, ctx, chats.builders, p.get('K')!, P({}));
    await getNodeContent(t.db, ctx, chats.builders, p.get('K')!, P({ tab: 'files' }));
    const after = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM review_state`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('revision-aware review and frozen bulk scopes', () => {
  it('marks only the focused revision Read; edits make it Missed again across all ancestors', async () => {
    const p = await ids('builders');
    const chain = ['K', 'K/Programming', 'K/Programming/Hackathons', 'K/Programming/Hackathons/Solutions', 'K/Programming/Hackathons/Solutions/Authentication', 'K/Programming/Hackathons/Solutions/Authentication/Tokens', 'K/Programming/Hackathons/Solutions/Authentication/Tokens/Refresh flow'].map((x) => p.get(x)!);
    const snapshot = async (status: string) => {
      const m = await getMap(t.db, ctx, chats.builders, P({ status, max_topic_depth: 'all' }));
      return chain.map((id) => m.nodes.find((n) => n.id === id)!);
    };
    const allBefore = await snapshot('all');
    const missedBefore = await snapshot('missed');
    const target = await nativeToId(M.refs['refresh-4']);
    // stale revision cannot be marked read
    const stale = await reviewOne(t.db, ctx, { message_id: target.id, status: 'read', revision: target.rev + 1, source: 'dwell' });
    expect(stale.applied).toBe(false);
    const ok = await reviewOne(t.db, ctx, { message_id: target.id, status: 'read', revision: target.rev, source: 'dwell' });
    expect(ok.applied).toBe(true);
    const allAfter = await snapshot('all');
    const missedAfter = await snapshot('missed');
    allAfter.forEach((n, i) => {
      expect(n.matching_message_count).toBe(allBefore[i].matching_message_count); // size unchanged under All
      expect(n.diameter).toBe(allBefore[i].diameter);
      expect(n.matching_missed_count).toBe(allBefore[i].matching_missed_count - 1);
    });
    missedAfter.forEach((n, i) => expect(n.matching_message_count).toBe(missedBefore[i].matching_message_count - 1));
    // Edit of the deep source: new revision is Missed again everywhere.
    await replayFixtureStep(t.db, fixtureContext(ctx.workspaceId), 'edit-deep', bundle);
    const edited = await nativeToId(M.refs['refresh-4']);
    expect(edited.rev).toBe(target.rev + 1);
    const missedEdited = await snapshot('missed');
    missedEdited.forEach((n, i) => expect(n.matching_message_count).toBe(missedBefore[i].matching_message_count));
    const msg = await getMessage(t.db, ctx, edited.id);
    expect(msg.review).toBe('missed');
    expect(msg.edited_at).not.toBeNull();
    // Manual Missed after a Read persists.
    await reviewOne(t.db, ctx, { message_id: edited.id, status: 'read', revision: edited.rev, source: 'dwell' });
    await reviewOne(t.db, ctx, { message_id: edited.id, status: 'missed', revision: edited.rev, source: 'manual' });
    expect((await getMessage(t.db, ctx, edited.id)).review).toBe('missed');
  });

  it('bulk updates only frozen (message, revision) pairs; new arrivals and concurrent edits stay Missed', async () => {
    const p = await ids('builders');
    const tokens = p.get('K/Programming/Hackathons/Solutions/Authentication/Tokens')!;
    const preview = await bulkPreview(t.db, ctx, chats.builders, { node_id: tokens, filter: { status: 'missed' } });
    expect(preview.count).toBeGreaterThan(5);
    // Concurrent edit of one in-scope message, and twenty new arrivals.
    const target = await nativeToId(M.refs['refresh-2']);
    await replayFixtureStep(
      t.db,
      fixtureContext(ctx.workspaceId),
      'x',
      {
        ...bundle,
        steps: {
          x: [
            {
              event: 'messages.update',
              data: [{ key: { remoteJid: M.chats.builders.jid, fromMe: false, id: M.refs['refresh-2'] }, update: { message: { editedMessage: { message: { conversation: 'Agreed. Store a token family id and revoke the whole family on reuse.' } } }, messageTimestamp: 1_790_000_000 } }],
            },
          ],
        },
      },
    );
    const before = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE kind IN ('text','media') AND state = 'active' AND workspace_id = ${ctx.workspaceId}::uuid`);
    await replayFixtureStep(t.db, fixtureContext(ctx.workspaceId), 'update-20', bundle);
    const after = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE kind IN ('text','media') AND state = 'active' AND workspace_id = ${ctx.workspaceId}::uuid`);
    expect(after.rows[0].n - before.rows[0].n).toBe(20);
    const res = await bulkExecute(t.db, ctx, { snapshot_id: preview.snapshotId, target: 'read' });
    expect(res.changedRevision).toBe(1);
    expect(res.updated).toBe(preview.count - 1);
    expect((await getMessage(t.db, ctx, target.id)).review).toBe('missed');
    // Idempotent re-execution returns the same result without changes.
    expect(await bulkExecute(t.db, ctx, { snapshot_id: preview.snapshotId, target: 'read' })).toEqual(res);
    // New arrivals start Missed.
    const newest = await t.db.execute<{ id: string }>(sql`SELECT id FROM messages WHERE chat_id = ${chats.builders}::uuid ORDER BY sent_at DESC NULLS LAST LIMIT 1`);
    expect((await getMessage(t.db, ctx, newest.rows[0].id)).review).toBe('missed');
    // Another user cannot execute this user's snapshot.
    await expect(bulkExecute(t.db, other, { snapshot_id: preview.snapshotId, target: 'missed' })).rejects.toThrow(/not found/);
  });
});

describe('replay, revocation and tombstones', () => {
  it('replays the twenty-message update exactly once and keeps distinct identical-text messages', async () => {
    const count = async () => (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE workspace_id = ${ctx.workspaceId}::uuid`)).rows[0].n;
    const before = await count();
    const stats = await replayFixtureStep(t.db, fixtureContext(ctx.workspaceId), 'update-20', bundle);
    expect(stats.inserted).toBe(0);
    expect(stats.duplicates).toBe(20);
    expect(await count()).toBe(before);
    const sg = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM messages WHERE chat_id = ${chats.builders}::uuid AND body = 'Sounds good'`);
    expect(sg.rows[0].n).toBe(2);
    // Sara's PN-addressed update message resolves to the same participant as her LID history.
    const sara = await t.db.execute<{ n: number }>(sql`SELECT count(DISTINCT sender_participant_id)::int AS n FROM messages WHERE chat_id = ${chats.builders}::uuid AND sender_label = 'Sara K'`);
    expect(sara.rows[0].n).toBe(1);
  });

  it('revocation removes text, file access and derived evidence; stale replay cannot restore it', async () => {
    const rubric = await nativeToId(M.refs.rubric);
    const p = await ids('builders');
    const before = (await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: 'all' }))).nodes.find((n) => n.id === p.get('K/Programming/Hackathons'))!.matching_message_count;
    await replayFixtureStep(t.db, fixtureContext(ctx.workspaceId), 'revoke-file', bundle);
    const msg = await getMessage(t.db, ctx, rubric.id);
    expect(msg.state).toBe('revoked');
    expect(msg.body).toBeNull();
    expect(msg.attachments).toEqual([]);
    const after = (await getMap(t.db, ctx, chats.builders, P({ status: 'all', max_topic_depth: 'all' }))).nodes.find((n) => n.id === p.get('K/Programming/Hackathons'))!.matching_message_count;
    expect(after).toBe(before - 1);
    const att = await t.db.select().from(s.attachments).where(eq(s.attachments.messageId, rubric.id));
    expect(att[0].availability).toBe('unavailable');
    expect(att[0].objectKey).toBeNull();
    const stats = await replayFixtureStep(t.db, fixtureContext(ctx.workspaceId), 'stale-replay', bundle);
    expect(stats.inserted).toBe(0);
    expect((await getMessage(t.db, ctx, rubric.id)).state).toBe('revoked');
    const leaked = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM message_revisions r JOIN messages m ON m.id = r.message_id WHERE m.id = ${rubric.id}::uuid AND r.body IS NOT NULL`);
    expect(leaked.rows[0].n).toBe(0);
  });
});

describe('taxonomy corrections at depth', () => {
  it('moves a deep subtree within its root, rejects cycles/cross-root moves, and merges with deduplication', async () => {
    const p = await ids('builders');
    const tokens = p.get('K/Programming/Hackathons/Solutions/Authentication/Tokens')!;
    const solutions = p.get('K/Programming/Hackathons/Solutions')!;
    const refresh = p.get('K/Programming/Hackathons/Solutions/Authentication/Tokens/Refresh flow')!;
    const lifetime = p.get('K/Programming/Hackathons/Solutions/Authentication/Tokens/Access token lifetime')!;
    const casual = p.get('G/Casual chat')!;
    await expect(patchTopic(t.db, ctx, solutions, { parent_id: refresh })).rejects.toThrow(/beneath itself|descendant/);
    await expect(patchTopic(t.db, ctx, tokens, { parent_id: casual })).rejects.toThrow(/same root/);
    await expect(patchTopic(t.db, ctx, tokens, { merge_into_id: refresh })).rejects.toThrow(/descendant/);
    // Direct SQL attempt at a cycle is rejected by the database trigger too.
    await expect(t.db.execute(sql`UPDATE topics SET parent_id = ${refresh}::uuid WHERE id = ${solutions}::uuid`)).rejects.toThrow();

    const msgIdBefore = (await allContentIds(chats.builders, refresh, { status: 'all' })).sort();
    await patchTopic(t.db, ctx, tokens, { parent_id: solutions });
    const tree = await loadTree(t.db, chats.builders);
    expect(tree.nodes.get(tokens)!.depth).toBe(4);
    expect(tree.nodes.get(refresh)!.depth).toBe(5);
    expect((await allContentIds(chats.builders, refresh, { status: 'all' })).sort()).toEqual(msgIdBefore);

    const refreshN = (await allContentIds(chats.builders, refresh, { status: 'all' })).length;
    const lifetimeIds = await allContentIds(chats.builders, lifetime, { status: 'all' });
    const refreshIds = await allContentIds(chats.builders, refresh, { status: 'all' });
    const union = new Set([...refreshIds, ...lifetimeIds]);
    const merged = await patchTopic(t.db, ctx, lifetime, { merge_into_id: refresh });
    expect(merged.mergedInto).toBe(refresh);
    expect((await allContentIds(chats.builders, refresh, { status: 'all' })).length).toBe(union.size);
    expect(union.size).toBeLessThan(refreshN + lifetimeIds.length); // overlap counted once
    // A saved filter on the retired topic resolves to the survivor.
    const viaRetired = await getMap(t.db, ctx, chats.builders, P({ status: 'all', topics: lifetime }));
    expect(viaRetired.nodes.find((n) => n.id === p.get('K'))!.matching_message_count).toBe(union.size);
    // Rename persists as a locked override.
    await patchTopic(t.db, ctx, refresh, { title: 'Refresh token flow' });
    const [row] = await t.db.select().from(s.topics).where(eq(s.topics.id, refresh));
    expect(row.title).toBe('Refresh token flow');
    expect(row.titleLocked).toBe(true);
  });
});

describe('isolation', () => {
  it('prevents another workspace from reading sources, counts, content, search results or related links', async () => {
    const p = await ids('builders');
    const any = (await t.db.select({ id: s.messages.id }).from(s.messages).where(and(eq(s.messages.chatId, chats.builders), eq(s.messages.state, 'active'))).limit(1))[0];
    await expect(getMap(t.db, other, chats.builders, P({}))).rejects.toThrow(/not found/);
    await expect(getNodeContent(t.db, other, chats.builders, p.get('K')!, P({}))).rejects.toThrow(/not found/);
    await expect(getMessage(t.db, other, any.id)).rejects.toThrow(/not found/);
    await expect(related(t.db, other, p.get('K/Programming')!)).rejects.toThrow(/not found/);
    await expect(reviewOne(t.db, other, { message_id: any.id, status: 'read', revision: 1 })).rejects.toThrow(/not found/);
    await expect(patchTopic(t.db, other, p.get('K/Programming')!, { title: 'x' })).rejects.toThrow(/not found/);
    const sr = await search(t.db, other, P({ q: 'token', status: 'all' }));
    expect(sr.results).toEqual([]);
    // A topic filter naming another workspace's topic matches nothing.
    const ws2Chat = await t.db.insert(s.chats).values({ workspaceId: other.workspaceId, sourceKind: 'fixture', nativeJid: 'x@g.us', kind: 'group', title: 'x', selected: true }).returning();
    const m = await getMap(t.db, other, ws2Chat[0].id, P({ status: 'all', topics: p.get('K/Programming')! }));
    expect(m.nodes.every((n) => n.matching_message_count === 0)).toBe(true);
  });

  it('shows verified related topics with current evidence on both sides', async () => {
    const study = await ids('study');
    const r = await related(t.db, ctx, study.get('K/Programming/Authentication/Tokens')!);
    expect(r.related.length).toBeGreaterThan(0);
    for (const l of r.related) {
      expect(l.a.evidence.length).toBeGreaterThan(0);
      expect(l.b.evidence.length).toBeGreaterThan(0);
    }
  });
});
