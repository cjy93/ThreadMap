'use client';
// Ask results as a concept map: the question in the middle of a left-to-right
// tree. Broader topics ("abstractions") lead to the topics Nemotron picked and to
// sibling topics where matching messages were found; the best messages hang off
// their topic as details. Nodes can be dragged, your own concepts added and
// linked, and the whole map exported.
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { PathItem } from './types';

export interface AskContextLine {
  sender: string;
  text: string;
  rel: 'replying to' | 'before' | 'reply' | 'after';
}

export interface AskResult {
  query: string;
  interpretation: string | null;
  /** Why the search went ahead on plain words (Nemotron slow, out of allowance or failing). */
  note?: string | null;
  /** Nemotron is still reading the question: search again with ?interp=<this> once it has. */
  interpretation_pending?: string | null;
  terms: string[];
  results: {
    message_id: string;
    chat_id: string;
    sender: string;
    snippet: string;
    review: string;
    topic_paths: PathItem[][];
    /** The messages around it: the one it replies to (or the one before), the reply (or the one after). */
    context?: { before?: AskContextLine; after?: AskContextLine };
  }[];
  topics: { chat_id: string; topic_id: string; path: PathItem[] }[];
}

type Kind = 'query' | 'abstraction' | 'topic' | 'sibling' | 'detail' | 'concept';
type CData = { kind: Kind; label: string; sub?: string; root?: string; missed?: boolean; onClick?: () => void; onRename?: (label: string) => void };

const KIND_LABEL: Record<Kind, string> = { query: 'Your question', abstraction: 'Abstraction', topic: 'Topic', sibling: 'Sibling', detail: 'Detail', concept: 'Your concept' };
const ROOT_BY_TITLE: Record<string, string> = { knowledge: 'KNOWLEDGE', 'general chat': 'GENERAL_CHAT', 'events and activities': 'EVENTS_ACTIVITIES', resources: 'RESOURCES' };
const DETAILS_PER_TOPIC = 4;
const MAX_DETAILS = 40;
const MAX_EXTRA_TOPICS = 3;
const COL_W = 290;
const ROW_H = { query: 90, abstraction: 64, topic: 72, sibling: 64, detail: 96, concept: 64 } as const;

const ConceptNode = memo(function ConceptNode({ data }: NodeProps<Node<CData>>) {
  const { kind, label, sub, root, missed, onClick, onRename } = data;
  return (
    <div className={`concept k-${kind} ${root ? `root-${root}` : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={kind === 'concept'} />
      <Handle type="source" position={Position.Right} />
      <span className="ctype">
        {KIND_LABEL[kind]}
        {missed ? <span className="missed"> · missed</span> : null}
      </span>
      {kind === 'concept' ? (
        <input className="nodrag" aria-label="Concept name" defaultValue={label} onChange={(e) => onRename?.(e.target.value)} />
      ) : onClick ? (
        <button className="clabel nodrag" onClick={onClick} title={label}>
          {label}
        </button>
      ) : (
        <span className="clabel">{label}</span>
      )}
      {sub ? <span className="csub">{sub}</span> : null}
    </div>
  );
});
const nodeTypes = { concept: ConceptNode };

interface Handlers {
  onOpenTopic: (chatId: string, topicId: string) => void;
  onOpenMessage: (chatId: string, messageId: string) => void;
}

/** Builds the concept graph and a tidy left-to-right layout (leaves stacked, parents centred on their children). */
export function buildConceptMap(res: AskResult, h: Handlers) {
  type T = { id: string; parent: string | null; data: CData; children: string[] };
  const items = new Map<string, T>();
  const put = (id: string, parent: string | null, data: CData) => {
    if (!items.has(id)) {
      items.set(id, { id, parent, data, children: [] });
      if (parent) items.get(parent)!.children.push(id);
    }
    return items.get(id)!;
  };
  put('q', null, { kind: 'query', label: res.query, sub: res.interpretation ?? undefined });
  const chosen = new Set(res.topics.map((t) => t.topic_id));

  // Each path becomes a chain from the question: root category → … → topic.
  const addPath = (chatId: string, path: PathItem[]) => {
    const root = ROOT_BY_TITLE[path[0]?.title.toLowerCase() ?? ''];
    let parent = 'q';
    path.forEach((p, i) => {
      const last = i === path.length - 1;
      const kind: Kind = chosen.has(p.id) ? 'topic' : last ? 'sibling' : 'abstraction';
      const t = put(p.id, parent, { kind, label: p.title, root, onClick: () => h.onOpenTopic(chatId, p.id) });
      // A node first seen as an ancestor can turn out to be a picked topic.
      if (chosen.has(p.id)) t.data.kind = 'topic';
      parent = p.id;
    });
    return parent;
  };
  for (const t of res.topics) addPath(t.chat_id, t.path);

  const crossLinks: { from: string; to: string }[] = [];
  const perTopic = new Map<string, number>();
  let details = 0;
  for (const r of res.results) {
    if (details >= MAX_DETAILS) break;
    const paths = r.topic_paths.length ? r.topic_paths : [[]];
    // Prefer a placement under a picked topic, so the detail sits where the question points.
    const path = paths.find((p) => p.some((x) => chosen.has(x.id))) ?? paths[0];
    const parent = path.length ? addPath(r.chat_id, path) : 'q';
    if ((perTopic.get(parent) ?? 0) >= DETAILS_PER_TOPIC) continue;
    perTopic.set(parent, (perTopic.get(parent) ?? 0) + 1);
    details++;
    const snippet = r.snippet.length > 110 ? `${r.snippet.slice(0, 110)}…` : r.snippet;
    const id = `m:${r.message_id}`;
    put(id, parent, { kind: 'detail', label: snippet || '(attachment)', sub: r.sender, missed: r.review === 'missed', onClick: () => h.onOpenMessage(r.chat_id, r.message_id) });
    // One node per message: its other topics link across branches instead of repeating it.
    for (const other of paths.filter((p) => p !== path && p.length).slice(0, MAX_EXTRA_TOPICS)) {
      const from = addPath(r.chat_id, other);
      if (from !== parent) crossLinks.push({ from, to: id });
    }
  }

  // A run of broader topics with one branch each reads as one step ("Programming › Hackathons › Solutions").
  const merge = (id: string) => {
    const t = items.get(id)!;
    while (t.data.kind === 'abstraction' && t.children.length === 1 && items.get(t.children[0])!.data.kind === 'abstraction') {
      const c = items.get(t.children[0])!;
      t.data = { ...c.data, label: `${t.data.label} › ${c.data.label}`, root: t.data.root ?? c.data.root };
      t.children = c.children;
      for (const g of c.children) items.get(g)!.parent = id;
      for (const l of crossLinks) if (l.from === c.id) l.from = id;
      items.delete(c.id);
    }
    t.children.forEach(merge);
  };
  merge('q');

  // Layout: depth → column; each leaf takes the next row; a parent sits at its children's middle.
  const pos = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  const place = (id: string, depth: number): number => {
    const t = items.get(id)!;
    let y: number;
    if (!t.children.length) {
      const hgt = ROW_H[t.data.kind];
      y = cursor + hgt / 2;
      cursor += hgt + 18;
    } else {
      const ys = t.children.map((c) => place(c, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(id, { x: depth * COL_W, y });
    return y;
  };
  place('q', 0);

  const nodes: Node<CData>[] = [...items.values()].map((t) => ({
    id: t.id,
    type: 'concept',
    position: { x: pos.get(t.id)!.x, y: pos.get(t.id)!.y - ROW_H[t.data.kind] / 2 },
    data: t.data,
  }));
  const edges: Edge[] = [...items.values()]
    .filter((t) => t.parent)
    .map((t) => ({
      id: `${t.parent}->${t.id}`,
      source: t.parent!,
      target: t.id,
      type: 'default',
      className: `e-${t.data.kind}`,
      label: t.parent === 'q' ? undefined : t.data.kind === 'detail' ? 'mentions' : t.data.kind === 'abstraction' ? undefined : 'includes',
    }));
  const seen = new Set(edges.map((e) => e.id));
  for (const l of crossLinks) {
    const eid = `${l.from}->${l.to}`;
    if (seen.has(eid) || !items.has(l.from)) continue;
    seen.add(eid);
    edges.push({ id: eid, source: l.from, target: l.to, type: 'default', className: 'e-cross', label: 'also in' });
  }
  return { nodes, edges };
}

// Readable text beats seeing everything at once: open on the question and the next two
// columns at a legible zoom; the minimap shows the rest.
const startView = (nodes: Node<CData>[]) => ({ nodes: nodes.filter((n) => n.position.x <= 2 * COL_W).map((n) => ({ id: n.id })), padding: 0.1, minZoom: 0.7, maxZoom: 1 });

function Inner({ res, onOpenTopic, onOpenMessage }: { res: AskResult } & Handlers) {
  const rf = useReactFlow();
  const built = useMemo(() => buildConceptMap(res, { onOpenTopic, onOpenMessage }), [res, onOpenTopic, onOpenMessage]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CData>>(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(built.edges);

  const tidy = useCallback(() => {
    // Built nodes return to their places; your concepts stay where you put them.
    setNodes((cur) => [...built.nodes, ...cur.filter((n) => n.data.kind === 'concept')]);
    requestAnimationFrame(() => rf.fitView({ ...startView(built.nodes), duration: 300 }));
  }, [built, setNodes, rf]);

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
    requestAnimationFrame(() => rf.fitView(startView(built.nodes)));
  }, [built, setNodes, setEdges, rf]);

  const addConcept = () => {
    const id = `c:${crypto.randomUUID()}`;
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const rename = (label: string) => setNodes((cur) => cur.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)));
    setNodes((cur) => [...cur, { id, type: 'concept', position: center, data: { kind: 'concept', label: 'New concept', onRename: rename } }]);
  };
  // Find in this map: matching boxes stand out, the rest fade; Enter steps from one to the next.
  const [find, setFind] = useState('');
  // Which match is centred (-1: none yet).
  const [hit, setHit] = useState(-1);
  const needle = find.trim().toLocaleLowerCase();
  const matches = needle ? nodes.filter((n) => `${n.data.label} ${n.data.sub ?? ''}`.toLocaleLowerCase().includes(needle)) : [];
  const shown = needle ? nodes.map((n) => ({ ...n, className: matches.includes(n) ? 'found' : 'dimmed' })) : nodes;
  const goTo = (i: number) => {
    if (!matches.length) return;
    const k = ((i % matches.length) + matches.length) % matches.length;
    const n = matches[k];
    setHit(k);
    rf.setCenter(n.position.x + 110, n.position.y + 30, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 });
  };
  const onConnect = useCallback((c: Connection) => setEdges((cur) => addEdge({ ...c, type: 'default', className: 'e-concept', label: 'relates to' }, cur)), [setEdges]);

  const exportJson = () => {
    const out = {
      query: res.query,
      interpretation: res.interpretation,
      nodes: nodes.map((n) => ({ id: n.id, kind: n.data.kind, label: n.data.label, detail: n.data.sub ?? null, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
      edges: edges.map((e) => ({ from: e.source, to: e.target, label: typeof e.label === 'string' ? e.label : null })),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    a.download = `threadmap-concepts-${res.query.slice(0, 40).replace(/[^\w]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="concept-tools" role="toolbar" aria-label="Concept map tools">
        <button onClick={() => rf.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })} title="Fit the whole map in view (or double-click empty space)">
          ⌖ Re-centre
        </button>
        <button onClick={tidy}>Tidy layout</button>
        <button onClick={addConcept}>+ Concept</button>
        <button onClick={exportJson}>Export</button>
        <span className="concept-find">
          <input
            type="search"
            aria-label="Find in this map"
            placeholder="Find in this map"
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              setHit(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                goTo(e.shiftKey ? hit - 1 : hit + 1);
              }
            }}
          />
          {needle ? <span className="counts">{!matches.length ? 'none' : hit >= 0 ? `${hit + 1}/${matches.length}` : `${matches.length} found · Enter`}</span> : null}
        </span>
      </div>
      <ReactFlow
        nodes={shown}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        zoomOnDoubleClick={false}
        onPaneClick={(e) => e.detail === 2 && rf.fitView({ padding: 0.12, duration: 300, maxZoom: 1 })}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="concept-minimap" nodeClassName={(n) => `mm-${(n.data as CData).kind}`} />
      </ReactFlow>
      <div className="concept-legend" aria-label="Legend">
        {(['query', 'abstraction', 'topic', 'sibling', 'detail', 'concept'] as Kind[]).map((k) => (
          <span key={k}>
            <i className={`sw k-${k}`} /> {KIND_LABEL[k]}
          </span>
        ))}
        <span>
          <i className="sw cross" /> Also in another topic
        </span>
      </div>
    </>
  );
}

export function AskMap(props: { res: AskResult; onBack: () => void } & Handlers) {
  const { onBack, ...rest } = props;
  return (
    <div style={{ position: 'absolute', inset: 0 }} aria-label="Concept map">
      <ReactFlowProvider>
        <Inner {...rest} />
      </ReactFlowProvider>
      <button className="concept-back" onClick={onBack}>
        ← Back to mind map
      </button>
    </div>
  );
}
