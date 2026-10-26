// Performance check on generated data: 10,000 messages, deep (8-level) and wide
// branches, overlapping placements. Measures cached-map/filter (with exact
// recursive counts), ancestor-content first page and size-aware layout over 30
// requests each. Writes reports/performance-data.json (consumed by the report).
// Usage: DATABASE_URL=... node dist/cli/perf.js [label]
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import * as s from '../db/schema';
import { layoutTree, overlaps } from '../lib/layout';
import { nodeDiameter } from '../lib/sizing';
import { getMap, getNodeContent, type AuthCtx } from '../server/api/service';
import { closeDb, getDb } from '../server/db';
import { ensureRoots, loadTree } from '../server/graph/tree';
import { ensurePrivateWorkspace } from '../server/workspace';

const N = Number(process.env.PERF_MESSAGES ?? 10_000);
const RUNS = 30;

async function main() {
  const db = getDb();
  const uid = `perf-${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(s.user).values({ id: uid, name: 'perf', email: `${uid}@example.invalid` });
  const ws = await ensurePrivateWorkspace(db, uid, 'perf');
  const [chat] = await db.insert(s.chats).values({ workspaceId: ws.id, sourceKind: 'fixture', nativeJid: 'perf@g.us', kind: 'group', title: 'Perf chat (generated)', selected: true, selectionEpoch: 1, taxonomyVersion: 1 }).returning();
  await ensureRoots(db, ws.id, chat.id);
  const roots = (await loadTree(db, chat.id)).roots;
  const K = roots.find((r) => r.root === 'KNOWLEDGE')!.id;
  // Topics: an 8-level chain plus 40 wide subjects × 8 children × 2 grandchildren.
  const topicIds: string[] = [];
  let parent = K;
  for (let d = 1; d <= 8; d++) {
    const [t] = await db.insert(s.topics).values({ workspaceId: ws.id, chatId: chat.id, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: parent, title: `Deep level ${d}`, provenance: 'fixture' }).returning({ id: s.topics.id });
    topicIds.push(t.id);
    parent = t.id;
  }
  const deepest = parent;
  for (let i = 0; i < 40; i++) {
    const [a] = await db.insert(s.topics).values({ workspaceId: ws.id, chatId: chat.id, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: K, title: `Subject ${i}`, provenance: 'fixture' }).returning({ id: s.topics.id });
    topicIds.push(a.id);
    for (let j = 0; j < 8; j++) {
      const [b] = await db.insert(s.topics).values({ workspaceId: ws.id, chatId: chat.id, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: a.id, title: `Subject ${i}.${j} with a fairly long descriptive title`, provenance: 'fixture' }).returning({ id: s.topics.id });
      topicIds.push(b.id);
      for (let k = 0; k < 2; k++) {
        const [c] = await db.insert(s.topics).values({ workspaceId: ws.id, chatId: chat.id, root: 'KNOWLEDGE', kind: 'TOPIC', parentId: b.id, title: `Leaf ${i}.${j}.${k}`, provenance: 'fixture' }).returning({ id: s.topics.id });
        topicIds.push(c.id);
      }
    }
  }
  // Messages in batches, each placed once (10% placed twice to test dedup).
  const base = Date.UTC(2026, 0, 1) / 1000;
  for (let off = 0; off < N; off += 1000) {
    const rows = Array.from({ length: Math.min(1000, N - off) }, (_, i) => {
      const n = off + i;
      return {
        workspaceId: ws.id,
        chatId: chat.id,
        nativeKeyHash: crypto.createHash('sha256').update(`p${n}`).digest('hex'),
        nativeId: `P${n}`,
        fromMe: n % 7 === 0,
        nativeKey: { remoteJid: 'perf@g.us' },
        senderLabel: `User ${n % 50}`,
        direction: (n % 7 === 0 ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
        kind: 'text' as const,
        body: `Generated message ${n} about topic ${n % topicIds.length}`,
        searchText: `generated message ${n} about topic ${n % topicIds.length}`,
        sentAt: new Date((base + n * 600) * 1000),
        receivedAt: new Date(),
        revisionDigest: 'x',
        ingestEventType: 'perf',
      };
    });
    const ins = await db.insert(s.messages).values(rows).returning({ id: s.messages.id });
    const pl = ins.flatMap((m, i) => {
      const n = off + i;
      const t = n % 50 === 0 ? deepest : topicIds[n % topicIds.length];
      const out = [{ workspaceId: ws.id, chatId: chat.id, messageId: m.id, topicId: t, provenance: 'fixture' as const, isPrimary: true }];
      if (n % 10 === 0) out.push({ workspaceId: ws.id, chatId: chat.id, messageId: m.id, topicId: topicIds[(n * 7) % topicIds.length], provenance: 'fixture' as const, isPrimary: false });
      return out;
    });
    for (let i = 0; i < pl.length; i += 1000) await db.insert(s.placements).values(pl.slice(i, i + 1000)).onConflictDoNothing();
  }
  await db.execute(sql`ANALYZE`);
  const ctx: AuthCtx = { userId: uid, workspaceId: ws.id, mode: 'private' };

  const time = async (fn: () => Promise<unknown>) => {
    const out: number[] = [];
    await fn(); // warm
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      await fn();
      out.push(performance.now() - t);
    }
    out.sort((a, b) => a - b);
    return { p50_ms: +out[Math.floor(RUNS * 0.5)].toFixed(1), p95_ms: +out[Math.floor(RUNS * 0.95)].toFixed(1), max_ms: +out[RUNS - 1].toFixed(1) };
  };
  const P = (o: Record<string, string>) => new URLSearchParams(o);
  const results: Record<string, unknown> = {
    map_all_depth2: await time(() => getMap(db, ctx, chat.id, P({ status: 'all', max_topic_depth: '2' }))),
    map_missed_all_levels: await time(() => getMap(db, ctx, chat.id, P({ status: 'missed', max_topic_depth: 'all' }))),
    map_date_topic_missed: await time(() => getMap(db, ctx, chat.id, P({ status: 'missed', from: '2026-01-10', to: '2026-02-20', topics: topicIds[3], max_topic_depth: '1' }))),
    content_root_first_page: await time(() => getNodeContent(db, ctx, chat.id, K, P({ status: 'all' }))),
    content_deep_first_page: await time(() => getNodeContent(db, ctx, chat.id, topicIds[2], P({ status: 'missed' }))),
  };
  const map = await getMap(db, ctx, chat.id, P({ status: 'all', max_topic_depth: 'all' }));
  const layoutRuns: number[] = [];
  let ov = 0;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const boxes = layoutTree(map.nodes.map((n) => ({ id: n.id, parentId: n.parent_id, diameter: n.diameter ?? 64, label: n.title })));
    layoutRuns.push(performance.now() - t);
    if (i === 0) ov = overlaps(boxes.values()).length;
  }
  layoutRuns.sort((a, b) => a - b);
  results.layout_200_nodes = { p50_ms: +layoutRuns[15].toFixed(2), p95_ms: +layoutRuns[28].toFixed(2), visible_nodes: map.nodes.length, overlaps: ov, min_d: Math.min(...map.nodes.map((n) => n.diameter ?? 0)), max_d: Math.max(...map.nodes.map((n) => n.diameter ?? 0)), ref_max: nodeDiameter(10_000) };
  const tree = await loadTree(db, chat.id);
  const data = {
    label: process.argv[2] ?? 'local',
    generated_at: new Date().toISOString(),
    database: (process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//***@'),
    messages: N,
    topics: tree.nodes.size,
    max_depth: tree.maxDepth,
    widest_branch_children: Math.max(...[...tree.nodes.values()].map((n) => n.childIds.length)),
    runs_per_operation: RUNS,
    results,
  };
  await db.delete(s.user).where(sql`id = ${uid}`);
  await closeDb();
  fs.mkdirSync('reports', { recursive: true });
  const p = 'reports/performance-data.json';
  const prev = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
  fs.writeFileSync(p, JSON.stringify({ ...prev, [data.label]: data }, null, 2));
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
