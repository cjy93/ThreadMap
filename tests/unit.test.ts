import { describe, expect, it } from 'vitest';
import { layoutTree, overlaps, type LayoutInput } from '../src/lib/layout';
import { DEFAULT_SIZING, nodeDiameter, SizingConfigError, validateSizingConfig } from '../src/lib/sizing';
import { extractJson } from '../src/server/ai/provider';
import { validateTaxonomy } from '../src/server/ai/taxonomy';
import { EncryptionKeyError, openPacked, parseEncryptionKey, sealPacked } from '../src/server/crypto';
import { projectMap } from '../src/server/graph/projection';
import type { Tree, TreeNode } from '../src/server/graph/tree';
import { normalizeMessageUpdate, normalizeWAMessage } from '../src/server/ingest/normalize';
import { PreselectionBuffer } from '../src/server/ingest/preselection';
import type { MessageEvent } from '../src/server/ingest/types';
import { canonicalUrl, extractUrls, normalizeSearch } from '../src/server/util';
import { loadViewConfig } from '../src/lib/config';

describe('node sizing', () => {
  const D = (n: number | null) => nodeDiameter(n, DEFAULT_SIZING);
  it('follows the bounded log-area formula for 0,1,10,100,1000,10000,10001', () => {
    const counts = [0, 1, 10, 100, 1000, 10000, 10001];
    const ds = counts.map((c) => D(c)!);
    expect(ds[0]).toBe(64);
    for (let i = 1; i < 6; i++) expect(ds[i]).toBeGreaterThan(ds[i - 1]);
    expect(ds[5]).toBeCloseTo(220, 9);
    expect(ds[6]).toBe(ds[5]);
    const t = Math.log1p(100) / Math.log1p(10000);
    expect(ds[3]).toBeCloseTo(Math.sqrt(64 ** 2 + (220 ** 2 - 64 ** 2) * t), 9);
    expect(D(1_000_000)).toBe(ds[5]);
  });
  it('treats unknown counts as no size and rejects invalid input', () => {
    expect(D(null)).toBeNull();
    expect(D(undefined as unknown as null)).toBeNull();
    expect(() => D(-1)).toThrow(SizingConfigError);
    expect(() => D(1.5)).toThrow(SizingConfigError);
    expect(() => validateSizingConfig({ minDiameterPx: 220, maxDiameterPx: 64, referenceCount: 10 })).toThrow();
    expect(() => validateSizingConfig({ minDiameterPx: 64, maxDiameterPx: 220, referenceCount: 0 })).toThrow();
    expect(() => validateSizingConfig({ minDiameterPx: Number.NaN, maxDiameterPx: 220, referenceCount: 10 })).toThrow();
    expect(() => loadViewConfig({ MAP_NODE_MIN_DIAMETER_PX: '300' })).toThrow();
  });
});

describe('layout', () => {
  it('produces non-overlapping reserved bounds at 200 nodes with mixed min/max bodies and long labels', () => {
    const nodes: LayoutInput[] = [];
    let id = 0;
    const add = (parent: string | null): string => {
      const me = `n${id++}`;
      const count = [0, 1, 7, 120, 10001][id % 5];
      nodes.push({ id: me, parentId: parent, diameter: nodeDiameter(count)!, label: id % 3 ? `Topic ${id}` : `A very long topic title number ${id} that must wrap and truncate` });
      return me;
    };
    const roots = [add(null), add(null), add(null)];
    const queue = [...roots];
    while (nodes.length < 200) {
      const p = queue.shift()!;
      for (let i = 0; i < 4 && nodes.length < 200; i++) queue.push(add(p));
    }
    const boxes = layoutTree(nodes);
    expect(boxes.size).toBe(200);
    expect(overlaps(boxes.values())).toEqual([]);
    // Equal counts → equal body diameters regardless of position.
    const d = [...boxes.values()].filter((b) => b.diameter === nodeDiameter(7)).map((b) => b.diameter);
    expect(new Set(d).size).toBe(1);
    // Deterministic.
    expect([...layoutTree(nodes).values()]).toEqual([...boxes.values()]);
  });

  it('top-down layout spreads siblings sideways without overlaps', () => {
    const nodes: LayoutInput[] = [{ id: 'r', parentId: null, diameter: 120, label: 'Root' }];
    for (let i = 0; i < 12; i++) nodes.push({ id: `c${i}`, parentId: 'r', diameter: 60 + i * 4, label: `Child ${i}` });
    for (let i = 0; i < 5; i++) nodes.push({ id: `g${i}`, parentId: 'c3', diameter: 50, label: `Grandchild ${i}` });
    const boxes = layoutTree(nodes, 'down');
    expect(overlaps(boxes.values())).toEqual([]);
    const kids = [...boxes.values()].filter((b) => b.id.startsWith('c'));
    // One row of children, all below the root, wider than tall.
    expect(new Set(kids.map((b) => b.top)).size).toBe(1);
    expect(kids.every((b) => b.top > boxes.get('r')!.top + boxes.get('r')!.height)).toBe(true);
    const xs = kids.map((b) => b.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(boxes.get('g0')!.top);
    expect(boxes.get('g0')!.top).toBeGreaterThan(kids[0].top);
  });
});

describe('Baileys event normalization (pinned 7.0.0-rc14 shapes)', () => {
  it('normalizes text, outgoing, media, system, unsupported, view-once and control events', () => {
    const text = normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'A', fromMe: false, participant: '9@lid', participantAlt: '5@s.whatsapp.net' }, messageTimestamp: 100, pushName: 'X', message: { conversation: '你好 multi\nline' } }, 'live') as MessageEvent;
    expect(text).toMatchObject({ type: 'message', kind: 'text', body: '你好 multi\nline', fromMe: false, senderJid: '9@lid', participantAltJid: '5@s.whatsapp.net', sentAtSec: 100, chatKind: 'group' });
    const out = normalizeWAMessage({ key: { remoteJid: '5@s.whatsapp.net', id: 'B', fromMe: true }, messageTimestamp: 101, message: { extendedTextMessage: { text: 'hi https://example.org/x).' } } }, 'live') as MessageEvent;
    expect(out).toMatchObject({ fromMe: true, senderJid: 'self', chatKind: 'direct', body: 'hi https://example.org/x).' });
    const doc = normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'C', participant: '9@lid' }, messageTimestamp: 1, message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: '../../etc/passwd', mimetype: 'application/pdf', caption: 'cap', fileLength: 10 } } } } }, 'history') as MessageEvent;
    expect(doc.kind).toBe('media');
    expect(doc.attachments[0]).toMatchObject({ mediaType: 'document', filename: '../../etc/passwd', size: 10 });
    expect(normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'D' }, messageTimestamp: 1, messageStubType: 27 }, 'history')).toMatchObject({ kind: 'system' });
    expect(normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'E' }, message: { locationMessage: {} } }, 'live')).toMatchObject({ kind: 'unsupported', sentAtSec: null });
    expect(normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'F' }, message: { viewOnceMessageV2: { message: { imageMessage: {} } } } }, 'live')).toMatchObject({ kind: 'unsupported', marker: 'view_once' });
    expect(normalizeWAMessage({ key: { remoteJid: 'status@broadcast', id: 'G' }, message: { conversation: 'x' } }, 'live')).toMatchObject({ type: 'ignored' });
    expect(normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'H' }, message: { protocolMessage: { type: 0, key: { id: 'A' } } } }, 'live')).toMatchObject({ type: 'revoke', targetNativeId: 'A' });
    expect(normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'I' }, message: { protocolMessage: { type: 14, key: { id: 'A' }, editedMessage: { conversation: 'new' }, timestampMs: 5000 } } }, 'live')).toMatchObject({ type: 'edit', newBody: 'new', editTimeSec: 5 });
    expect(normalizeMessageUpdate({ key: { remoteJid: '1@g.us', id: 'A' }, update: { status: 4 } })).toMatchObject({ type: 'ignored' });
    expect(normalizeMessageUpdate({ key: { remoteJid: '1@g.us', id: 'A' }, update: { message: null, messageStubType: 1 } })).toMatchObject({ type: 'revoke' });
    const eph = normalizeWAMessage({ key: { remoteJid: '1@g.us', id: 'J' }, messageTimestamp: 1, message: { ephemeralMessage: { message: { extendedTextMessage: { text: 't', contextInfo: { expiration: 60 } } } } } }, 'live') as MessageEvent;
    expect(eph.ephemeralSec).toBe(60);
  });
});

describe('preselection buffer', () => {
  const ev = (jid: string, body: string): MessageEvent => ({ type: 'message', origin: 'history', chatJid: jid, chatKind: 'group', nativeId: body, fromMe: false, participantJid: null, participantAltJid: null, senderJid: 'x', senderName: null, sentAtSec: 1, kind: 'text', body, attachments: [], replyToNativeId: null, ephemeralSec: null, marker: null });
  it('enforces size and TTL and releases only selected chats', () => {
    let now = 0;
    const b = new PreselectionBuffer(1000, 300_000, () => now);
    expect(b.add(ev('a', 'x'))).toBe(true);
    expect(b.add(ev('b', 'y'.repeat(2000)))).toBe(false);
    expect(b.warnings[0]).toMatchObject({ type: 'preselection_overflow', chatJid: 'b' });
    b.add(ev('c', 'z'));
    expect(b.release((j) => j === 'a').map((e) => e.body)).toEqual(['x']);
    now = 300_001;
    b.expire();
    expect(b.count).toBe(0);
    expect(b.warnings.some((w) => w.type === 'preselection_expired' && w.chatJid === 'c')).toBe(true);
  });
});

describe('crypto', () => {
  it('round-trips with the right key and fails closed with a wrong key', () => {
    const k = parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
    const packed = sealPacked(k, Buffer.from('secret'), 'aad');
    expect(openPacked(k, packed, 'aad').toString()).toBe('secret');
    expect(() => openPacked(parseEncryptionKey(Buffer.alloc(32, 8).toString('base64')), packed, 'aad')).toThrow(EncryptionKeyError);
    expect(() => openPacked(k, packed, 'other')).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey(undefined)).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('c2hvcnQ=')).toThrow(EncryptionKeyError);
  });
});

function makeTree(): Tree {
  const nodes = new Map<string, TreeNode>();
  const add = (id: string, parentId: string | null, root: TreeNode['root'], title: string, depth: number) => {
    nodes.set(id, { id, parentId, root, kind: parentId ? 'TOPIC' : 'CATEGORY', title, depth, childIds: [], needsReview: false, provenance: 'model' });
    if (parentId) nodes.get(parentId)!.childIds.push(id);
  };
  add('K', null, 'KNOWLEDGE', 'Knowledge', 0);
  add('G', null, 'GENERAL_CHAT', 'General Chat', 0);
  add('R', null, 'RESOURCES', 'Resources', 0);
  add('p', 'K', 'KNOWLEDGE', 'Programming', 1);
  add('h', 'p', 'KNOWLEDGE', 'Hackathons', 2);
  return { chatId: 'c', nodes, roots: ['K', 'G', 'R'].map((r) => nodes.get(r)!), maxDepth: 2 };
}

describe('taxonomy validation', () => {
  const units = [
    { unitKey: 'u1', primaryRoot: 'KNOWLEDGE' as const, messageRefs: ['m1'] },
    { unitKey: 'u2', primaryRoot: 'GENERAL_CHAT' as const, messageRefs: ['m2'] },
  ];
  it('rejects cycles, unknown parents, cross-root assignments and drops empty topics', () => {
    const plan = validateTaxonomy(
      makeTree(),
      {
        nodes: [
          { key: 'a', parent: 'b', title: 'A', aliases: [], may_subdivide: false },
          { key: 'b', parent: 'a', title: 'B', aliases: [], may_subdivide: false },
          { key: 'x', parent: 'nope', title: 'X', aliases: [], may_subdivide: false },
          { key: 's', parent: 'h', title: 'Solutions', aliases: [], may_subdivide: true },
          { key: 'e', parent: 'h', title: 'Empty', aliases: [], may_subdivide: false },
          { key: 'dup', parent: 'K', title: 'programming', aliases: [], may_subdivide: false },
        ],
        assignments: [
          { unit_key: 'u1', topic: 's' },
          { unit_key: 'u2', topic: 'p' },
          { unit_key: 'zzz', topic: 'p' },
        ],
        secondary_placements: [],
        no_useful_subdivision: false,
      },
      units,
    );
    expect(plan.rejected.join('|')).toMatch(/cycle/);
    expect(plan.rejected.join('|')).toMatch(/unknown parent/);
    expect(plan.rejected.join('|')).toMatch(/across roots/);
    expect(plan.rejected.join('|')).toMatch(/empty topic Empty/);
    expect(plan.newTopics.map((t) => t.title)).toEqual(['Solutions']);
    expect(plan.unitTargets.get('u2')).toEqual({ kind: 'needs_review', root: 'GENERAL_CHAT' });
  });
});

describe('projection budget', () => {
  it('never renders more than the visible-node budget and reports continuation', () => {
    const tree = makeTree();
    for (let i = 0; i < 300; i++) {
      const id = `t${i}`;
      tree.nodes.set(id, { id, parentId: 'h', root: 'KNOWLEDGE', kind: 'TOPIC', title: `T${String(i).padStart(3, '0')}`, depth: 3, childIds: [], needsReview: false, provenance: 'model' });
      tree.nodes.get('h')!.childIds.push(id);
    }
    tree.maxDepth = 3;
    const view = { ...loadViewConfig({}), maxVisibleNodes: 200 };
    const p = projectMap({ tree, discussions: [], counts: { topics: new Map(), discussions: new Map(), countVersion: 'x', filterFingerprint: 'y' }, depth: 'all', collapsed: new Set(), childOffsets: {}, selectedTopicIds: [], filterActive: false, view });
    expect(p.nodes.length).toBeLessThanOrEqual(200);
    const h = p.nodes.find((n) => n.id === 'h')!;
    expect(h.next_child_offset).toBe(50);
    const page2 = projectMap({ tree, discussions: [], counts: { topics: new Map(), discussions: new Map(), countVersion: 'x', filterFingerprint: 'y' }, depth: 'all', collapsed: new Set(), focusId: 'h', childOffsets: { h: 250 }, selectedTopicIds: [], filterActive: false, view });
    expect(page2.nodes.length).toBe(51);
    expect(page2.focus!.breadcrumbs.map((b) => b.depth)).toEqual([0, 1, 2]);
    expect(page2.nodes.find((n) => n.id === 'h')!.depth).toBe(2); // focus does not renumber
  });
});

describe('util', () => {
  it('normalizes search text and URLs', () => {
    expect(normalizeSearch('  ＴＯＫＥＮ  Ü ')).toBe('token ü');
    expect(extractUrls('see https://a.org/x?utm_source=1#f, and http://b.io.')).toEqual(['https://a.org/x?utm_source=1#f', 'http://b.io']);
    expect(canonicalUrl('https://WWW.A.org/x/?utm_source=1#f')).toBe('https://a.org/x');
    expect(extractJson('<think>blah {x}</think>```json\n{"a":"}"}\n```')).toBe('{"a":"}"}');
  });
});

describe('top-down building', () => {
  // Eight broad topics proposed under Knowledge (which already has Programming), plus a
  // narrower one nested beneath a new topic in the same answer.
  const proposal = {
    nodes: [
      ...['Music', 'Art', 'History', 'Finance', 'Health', 'Travel', 'Cooking', 'Sport'].map((title, i) => ({ key: `b${i}`, parent: 'ROOT:KNOWLEDGE', title, aliases: [], may_subdivide: false })),
      { key: 'deep', parent: 'b1', title: 'Drawing', aliases: [], may_subdivide: false },
    ],
    assignments: Array.from({ length: 8 }, (_, i) => ({ unit_key: `u${i}`, topic: `b${i}` })).concat([{ unit_key: 'u8', topic: 'deep' }]),
    secondary_placements: [],
    no_useful_subdivision: false,
  };
  const units = Array.from({ length: 9 }, (_, i) => ({ unitKey: `u${i}`, primaryRoot: 'KNOWLEDGE' as const, messageRefs: [`m${i}`] }));

  it('never lets a level go over six, and builds one level at a time', () => {
    const tree = makeTree();
    const plan = validateTaxonomy(tree, proposal, units, { newParentIds: new Set(tree.roots.map((r) => r.id)), oneLevel: true });
    // Knowledge already has Programming: five more fit, the rest stay on Knowledge to be placed later.
    const underK = plan.newTopics.filter((t) => t.parentRef.kind === 'existing' && t.parentRef.id === 'K');
    expect(underK.length).toBe(5);
    expect(plan.newTopics.every((t) => t.parentRef.kind === 'existing')).toBe(true);
    expect(plan.unitTargets.get('u7')).toEqual({ kind: 'existing', id: 'K' });
    // "Drawing" waits for Art to be refined; its discussion goes to Art, marked to split next.
    expect(plan.newTopics.find((t) => t.title === 'Drawing')).toBeUndefined();
    const art = plan.newTopics.find((t) => t.title === 'Art')!;
    expect(plan.unitTargets.get('u8')).toEqual({ kind: 'new', key: art.key });
    expect(art.narrower).toBe(true);
  });

  it('adds nothing beneath an existing topic while building the first level', () => {
    const tree = makeTree();
    const plan = validateTaxonomy(
      tree,
      { nodes: [{ key: 'n', parent: 'h', title: 'Solutions', aliases: [], may_subdivide: false }], assignments: [{ unit_key: 'u0', topic: 'n' }], secondary_placements: [], no_useful_subdivision: false },
      units.slice(0, 1),
      { newParentIds: new Set(tree.roots.map((r) => r.id)), oneLevel: true },
    );
    expect(plan.newTopics).toEqual([]);
    expect(plan.unitTargets.get('u0')).toEqual({ kind: 'existing', id: 'h' });
    expect(plan.subdivideExisting).toEqual(['h']);
  });
});

describe('opening branches beyond the node budget', () => {
  it('loads a branch the budget left out when it is opened, at any depth', () => {
    // Knowledge > 6 topics > 6 subtopics each > 3 more each: far over a budget of 20 nodes.
    const nodes = new Map<string, TreeNode>();
    const add = (id: string, parentId: string | null, depth: number) => {
      nodes.set(id, { id, parentId, root: 'KNOWLEDGE', kind: parentId ? 'TOPIC' : 'CATEGORY', title: id, depth, childIds: [], needsReview: false, provenance: 'model' });
      if (parentId) nodes.get(parentId)!.childIds.push(id);
    };
    add('K', null, 0);
    for (let a = 0; a < 6; a++) {
      add(`a${a}`, 'K', 1);
      for (let b = 0; b < 6; b++) {
        add(`a${a}b${b}`, `a${a}`, 2);
        for (let c = 0; c < 3; c++) add(`a${a}b${b}c${c}`, `a${a}b${b}`, 3);
      }
    }
    const tree: Tree = { chatId: 'c', nodes, roots: [nodes.get('K')!], maxDepth: 3 };
    const view = { ...loadViewConfig({}), maxVisibleNodes: 20 };
    const base = { tree, discussions: [], counts: { topics: new Map(), discussions: new Map(), countVersion: 'x', filterFingerprint: 'y' }, depth: 'all' as const, collapsed: new Set<string>(), childOffsets: {}, selectedTopicIds: [], filterActive: false, view };

    const first = projectMap(base);
    expect(first.nodes.length).toBe(20);
    // A level-2 topic whose children did not fit says so, so opening it can load them.
    const cut = first.nodes.find((n) => n.depth === 2 && n.children_shown === 0)!;
    expect(cut.boundary).toBe(true);
    expect(cut.child_topic_count).toBe(3);

    // Opened: its children come anyway, and they in turn can be opened.
    const opened = projectMap({ ...base, expandIds: [cut.id] });
    const kids = opened.nodes.filter((n) => n.parent_id === cut.id);
    expect(kids.map((n) => n.depth)).toEqual([3, 3, 3]);
    expect(opened.nodes.find((n) => n.id === cut.id)!.boundary).toBe(false);
  });
});

describe('database TLS', () => {
  it('verifies the certificate when one is given, and refuses to run without one when required', async () => {
    const { pgSslOptions } = await import('../src/server/db');
    expect(pgSslOptions({ DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----x' })).toEqual({ ca: '-----BEGIN CERTIFICATE-----x', rejectUnauthorized: true });
    expect(() => pgSslOptions({ DATABASE_REQUIRE_TLS: '1' })).toThrow(/verified TLS is required/);
    expect(() => pgSslOptions({ APP_MODE: 'hosted' })).toThrow(/verified TLS is required/);
    expect(pgSslOptions({})).toBeUndefined(); // local container on Docker's private network
  });

  it('passes the TLS, auto-delete and links settings to the processes that read them', async () => {
    const { CHILDREN } = await import('../src/processes/supervisor');
    const worker = CHILDREN.find((c) => c.name === 'worker')!;
    expect(worker.allow).toEqual(expect.arrayContaining(['AUTO_DELETE_AFTER_MINUTES', 'CROSS_CHAT_LINKS']));
  });
});
