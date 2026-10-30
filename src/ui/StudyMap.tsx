'use client';
// Concept map of one message, for studying: Nemotron Ultra's concepts in a
// left-to-right tree from the core subject (other links drawn across), each
// explained and cited to the chat messages and web pages it comes from, plus a
// study guide in learning order. Built in the worker; this view waits for it.
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { api, sourceNumbers } from './client';
import type { StudyMap, StudyMapState, StudySource } from './types';

type Kind = StudyMap['concepts'][number]['kind'];
// chat: how many chat messages it was drawn from (its card lists them).
// full: the whole explanation, shown while the concept is picked (sub is its short preview).
type SData = { kind: Kind; label: string; sub: string; full: string; chat: number; selected: boolean; onClick: () => void };

const KIND_LABEL: Record<Kind, string> = { core: 'Subject', concept: 'Concept', detail: 'Detail', example: 'Example', question: 'Question' };
const COL_W = 300;
const ROW_H = 92;
const POLL_MS = 3000;
const LOOSE_Y = -60;

const StudyNode = memo(function StudyNode({ data }: NodeProps<Node<SData>>) {
  return (
    <div className={`concept study s-${data.kind} ${data.selected ? 'picked' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <span className="ctype">
        {KIND_LABEL[data.kind]}
        {data.chat ? (
          <span className="cchat" title={`Drawn from ${data.chat} chat message${data.chat === 1 ? '' : 's'}: click the title, then a message, to open its discussion`}>
            💬 {data.chat}
          </span>
        ) : null}
      </span>
      <button className="clabel nodrag" onClick={data.onClick} title={`${data.label}: click to read the explanation`}>
        {data.label}
      </button>
      {data.sub ? <span className="csub">{data.selected ? data.full : data.sub}</span> : null}
    </div>
  );
});
// The heading over concepts Nemotron did not link to the subject.
const LooseHeading = memo(function LooseHeading() {
  return (
    <div className="study-loose" title="Nemotron wrote these from the same messages but did not link them to the subject">
      Also in these messages (not linked to the subject)
    </div>
  );
});
const nodeTypes = { study: StudyNode, loose: LooseHeading };

// A link's label read the other way, for links the tree draws against their direction
// (e.g. "question answered by detail" drawn detail → question reads "answer to").
const INVERSE: Record<string, string> = {
  'answered by': 'answer to',
  'answer to': 'answered by',
  answers: 'answered by',
  'part of': 'has part',
  'has part': 'part of',
  'example of': 'has example',
  'has example': 'example of',
  'is a': 'includes',
  includes: 'is a',
  uses: 'used by',
  'used by': 'uses',
  requires: 'required by',
  'required by': 'requires',
  'leads to': 'follows from',
  'follows from': 'leads to',
  causes: 'caused by',
  'caused by': 'causes',
};
export function reverseLabel(label: string): string {
  const l = label.trim();
  if (!l) return '';
  return INVERSE[l.toLowerCase()] ?? `← ${l}`;
}

/**
 * Tree from the core along the relations (whichever way they point); links that
 * would close a loop are drawn across. Concepts not linked to the core get a column of their own.
 */
export function layoutStudyMap(map: StudyMap) {
  const core = map.concepts.find((c) => c.kind === 'core') ?? map.concepts[0];
  const near = new Map<string, { other: string; rel: StudyMap['relations'][number] }[]>();
  for (const r of map.relations) {
    near.set(r.from, [...(near.get(r.from) ?? []), { other: r.to, rel: r }]);
    near.set(r.to, [...(near.get(r.to) ?? []), { other: r.from, rel: r }]);
  }
  const parent = new Map<string, { key: string; rel: StudyMap['relations'][number] } | null>([[core.key, null]]);
  const children = new Map<string, string[]>(map.concepts.map((c) => [c.key, []]));
  const queue = [core.key];
  while (queue.length) {
    const k = queue.shift()!;
    for (const { other, rel } of near.get(k) ?? []) {
      if (parent.has(other) || !children.has(other)) continue;
      parent.set(other, { key: k, rel });
      children.get(k)!.push(other);
      queue.push(other);
    }
  }
  const loose = map.concepts.filter((c) => !parent.has(c.key)).map((c) => c.key);
  const pos = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  const place = (k: string, depth: number): number => {
    const kids = children.get(k)!;
    let y: number;
    if (!kids.length) {
      y = cursor + ROW_H / 2;
      cursor += ROW_H + 16;
    } else {
      const ys = kids.map((c) => place(c, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(k, { x: depth * COL_W, y });
    return y;
  };
  place(core.key, 0);
  const maxDepth = Math.max(0, ...[...pos.values()].map((p) => p.x / COL_W));
  // Below a heading saying they are not linked to the subject (placed at LOOSE_Y).
  loose.forEach((k, i) => pos.set(k, { x: (maxDepth + 1) * COL_W, y: LOOSE_Y + 40 + ROW_H / 2 + i * (ROW_H + 16) }));
  const tree = new Set([...parent.values()].filter(Boolean).map((p) => p!.rel));
  const edges: Edge[] = [];
  for (const [k, p] of parent) {
    if (!p) continue;
    // Drawn parent → child; if the relation points child → parent, read its label the other way.
    const label = p.rel.from === p.key ? p.rel.label : reverseLabel(p.rel.label);
    edges.push({ id: `t:${p.key}->${k}`, source: p.key, target: k, type: 'default', className: 'e-study', label: label || undefined });
  }
  map.relations.forEach((r, i) => {
    if (!tree.has(r) && pos.has(r.from) && pos.has(r.to)) edges.push({ id: `x:${i}`, source: r.from, target: r.to, type: 'default', className: 'e-cross', label: r.label || undefined });
  });
  return { pos, edges, coreKey: core.key, parent, loose, looseX: (maxDepth + 1) * COL_W };
}

/**
 * What lights up when a concept is clicked: the concept, its path back to the core, its
 * branch below it, and every concept it links to directly. Everything else is dimmed.
 */
export function branchOf(map: StudyMap, layout: ReturnType<typeof layoutStudyMap>, key: string) {
  const nodes = new Set([key]);
  for (let p = layout.parent.get(key); p; p = layout.parent.get(p.key)) nodes.add(p.key);
  const below = [key];
  while (below.length) {
    const k = below.pop()!;
    for (const [child, p] of layout.parent) {
      if (p?.key !== k || nodes.has(child)) continue;
      nodes.add(child);
      below.push(child);
    }
  }
  const tree = new Set(nodes);
  for (const r of map.relations) {
    if (r.from === key) nodes.add(r.to);
    if (r.to === key) nodes.add(r.from);
  }
  // Tree links along the path and branch, and any link touching the concept itself.
  const edges = new Set(
    layout.edges
      .filter((e) => (e.id.startsWith('t:') && tree.has(e.source) && tree.has(e.target)) || e.source === key || e.target === key)
      .map((e) => e.id),
  );
  return { nodes, edges };
}

const LINKS = /\[\[([0-9a-f-]{36})\]\]/g;

/** Text with the chat messages it mentions ("asked in [3]") as numbered links that open them. */
function Linked({ text, sources, numberOf, onOpenMessage }: { text: string; sources: Record<string, StudySource>; numberOf: Map<string, number>; onOpenMessage: (chatId: string, id: string) => void }) {
  const parts = text.split(LINKS);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const s = sources[part];
        if (!s) return 'a chat message';
        const tip = `${s.sender}: “${s.snippet.slice(0, 160)}”. Click to open the message.`;
        return (
          <button key={i} className="cite" title={tip} aria-label={tip} onClick={() => onOpenMessage(s.chat_id, part)}>
            [{numberOf.get(part)}]
          </button>
        );
      })}
    </>
  );
}
/** The same text as plain words, for a node's short preview. */
const plainText = (text: string, numberOf: Map<string, number>) => text.replace(LINKS, (_, id: string) => (numberOf.has(id) ? `[${numberOf.get(id)}]` : 'a chat message'));

/** [1] chat messages (open them) and [W1] web pages (open in a new tab). */
function Cites({ messages, web, map, sources, numberOf, onOpenMessage }: { messages: string[]; web: number[]; map: StudyMap; sources: Record<string, StudySource>; numberOf: Map<string, number>; onOpenMessage: (chatId: string, id: string) => void }) {
  return (
    <>
      {messages.map((id) => {
        const s = sources[id];
        if (!s) return null;
        const tip = `${s.sender}: “${s.snippet.slice(0, 160)}”. Click to open the message.`;
        return (
          <button key={id} className="cite" title={tip} aria-label={tip} onClick={() => onOpenMessage(s.chat_id, id)}>
            [{numberOf.get(id)}]
          </button>
        );
      })}
      {web.map((i) => {
        const w = map.web.results[i];
        return w ? (
          <a key={`w${i}`} className="cite web" href={w.url} target="_blank" rel="noopener noreferrer" title={`${w.title} (opens the web page)`}>
            [W{i + 1}]
          </a>
        ) : null;
      })}
    </>
  );
}

function MapPane({ map, sources, numberOf, onOpenMessage }: { map: StudyMap; sources: Record<string, StudySource>; numberOf: Map<string, number>; onOpenMessage: (chatId: string, id: string) => void }) {
  const rf = useReactFlow();
  const layout = useMemo(() => layoutStudyMap(map), [map]);
  // The concept whose card is open; null when the card is closed (✕ or a click on empty space).
  const [picked, setPicked] = useState<string | null>(layout.coreKey);
  // The concept whose branch is highlighted (others dimmed) until a double-click anywhere.
  const [focus, setFocus] = useState<string | null>(null);
  const lit = useMemo(() => (focus && layout.pos.has(focus) ? branchOf(map, layout, focus) : null), [focus, map, layout]);
  const pick = (key: string) => {
    setPicked(key);
    setFocus(key);
  };
  const preview = (text: string) => {
    const p = plainText(text, numberOf);
    return p.length > 90 ? `${p.slice(0, 90)}…` : p;
  };
  const conceptNodes: Node<SData>[] = map.concepts.map((c) => {
    const p = layout.pos.get(c.key)!;
    return {
      id: c.key,
      type: 'study',
      position: { x: p.x, y: p.y - ROW_H / 2 },
      className: lit && !lit.nodes.has(c.key) ? 'dim' : undefined,
      // Picked, it opens to its whole text, drawn over the concepts below it.
      zIndex: c.key === picked ? 1000 : 0,
      data: { kind: c.kind, label: c.label, sub: preview(c.explanation), full: plainText(c.explanation, numberOf), chat: c.messages.filter((id) => sources[id]).length, selected: c.key === picked, onClick: () => pick(c.key) },
    };
  });
  const nodes: Node[] = layout.loose.length
    ? [...conceptNodes, { id: 'loose-heading', type: 'loose', position: { x: layout.looseX, y: LOOSE_Y }, data: {}, selectable: false, draggable: false }]
    : conceptNodes;
  const edges = lit ? layout.edges.map((e) => ({ ...e, className: `${e.className ?? ''} ${lit.edges.has(e.id) ? 'lit' : 'dim'}` })) : layout.edges;
  useEffect(() => {
    requestAnimationFrame(() => rf.fitView({ padding: 0.12, maxZoom: 1 }));
  }, [layout, rf]);
  const c = map.concepts.find((x) => x.key === picked);
  const links = map.relations.filter((r) => r.from === picked || r.to === picked);
  const labelOf = (k: string) => map.concepts.find((x) => x.key === k)?.label ?? k;
  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        onNodeClick={(_, n) => n.type === 'study' && pick(n.id)}
        onPaneClick={() => setPicked(null)}
        // A double-click anywhere on the map releases the highlight.
        onDoubleClick={() => setFocus(null)}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {c ? (
        <aside className="study-panel" aria-label="Concept">
          <button className="study-panel-close" aria-label="Close this card" title="Close (click any concept to open its card again)" onClick={() => setPicked(null)}>
            ✕
          </button>
          <div className="ctype">{KIND_LABEL[c.kind]}</div>
          <h3>{c.label}</h3>
          <p>{c.explanation ? <Linked text={c.explanation} sources={sources} numberOf={numberOf} onOpenMessage={onOpenMessage} /> : 'No explanation given.'}</p>
          {/* Nemotron wrote this from these chat messages: each opens in its discussion and chatroom. */}
          {c.messages.some((id) => sources[id]) ? (
            <div className="study-from">
              <div className="counts">From the chat · click one to open its discussion</div>
              {c.messages.map((id) => {
                const s = sources[id];
                return s ? (
                  <button key={id} className="study-msg" onClick={() => onOpenMessage(s.chat_id, id)} title="Open this message with its discussion and chatroom">
                    <span className="meta">
                      <strong>{s.sender}</strong>
                      {s.sent_at ? ` · ${new Date(s.sent_at).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
                    </span>
                    {s.snippet || '(no text)'}
                  </button>
                ) : null;
              })}
            </div>
          ) : null}
          {c.web.length ? (
            <p className="counts">
              Web: <Cites messages={[]} web={c.web} map={map} sources={sources} numberOf={numberOf} onOpenMessage={onOpenMessage} />
            </p>
          ) : null}
          {links.length ? (
            <ul className="study-links">
              {links.map((r, i) => (
                <li key={i}>
                  {r.from === picked ? (
                    <>
                      <em>{r.label || 'relates to'}</em> → <button onClick={() => pick(r.to)}>{labelOf(r.to)}</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => pick(r.from)}>{labelOf(r.from)}</button> → <em>{r.label || 'relates to'}</em> this
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </aside>
      ) : null}
      <div className="concept-legend" aria-label="Legend">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <span key={k}>
            <i className={`sw s-${k}`} /> {KIND_LABEL[k]}
          </span>
        ))}
        <span>
          <i className="sw cross" /> Other link
        </span>
      </div>
    </>
  );
}

function GuidePane({ map, sources, numberOf, onOpenMessage }: { map: StudyMap; sources: Record<string, StudySource>; numberOf: Map<string, number>; onOpenMessage: (chatId: string, id: string) => void }) {
  const cite = (m: string[], w: number[]) => <Cites messages={m} web={w} map={map} sources={sources} numberOf={numberOf} onOpenMessage={onOpenMessage} />;
  return (
    <article className="study-guide" aria-label="Study guide">
      <div className="path">{map.topic_path}</div>
      <h2>{map.title}</h2>
      {map.summary ? <p className="lede">{map.summary}</p> : null}
      {map.guide.map((g, i) => (
        <section key={i}>
          <h3>
            {i + 1}. {g.heading}
          </h3>
          <p>
            <Linked text={g.text} sources={sources} numberOf={numberOf} onOpenMessage={onOpenMessage} /> {cite(g.messages.filter((id) => !g.text.includes(id)), g.web)}
          </p>
        </section>
      ))}
      {map.gaps.length ? (
        <section>
          <h3>Still open: worth studying next</h3>
          <ul>
            {map.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>Web sources</h3>
        {map.web.results.length ? (
          <ol className="study-web">
            {map.web.results.map((w, i) => (
              <li key={i} value={i + 1}>
                <a href={w.url} target="_blank" rel="noopener noreferrer">
                  {w.title}
                </a>{' '}
                <span className="counts">{URL.canParse(w.url) ? new URL(w.url).hostname : ''}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="counts">{map.web.note ?? 'Nemotron Ultra found the chat explained enough, so it did not search the web.'}</p>
        )}
        {map.web.queries.length ? <p className="counts">Searched for: {map.web.queries.map((q) => `“${q}”`).join(', ')}</p> : null}
      </section>
      <p className="counts">
        Read {map.read.messages} messages from everyone and {map.read.discussions} discussion summaries in this branch, from the opened topic up to {map.topic_path.split(' › ')[0]}.
      </p>
    </article>
  );
}

const STEPS: { state: string; label: string }[] = [
  { state: 'reading', label: 'Reading the discussion, its replies and the topic branch up to the root' },
  { state: 'searching', label: 'Searching the web for documentation' },
  { state: 'building', label: 'Linking the concepts and writing the study guide' },
];

export function StudyMapView({
  messageId,
  onBack,
  onOpenMessage,
  sourceShown,
  onToggleSource,
}: {
  messageId: string;
  onBack: () => void;
  onOpenMessage: (chatId: string, id: string) => void;
  /** Whether the Source panel (the message this map is about) is showing beside the map. */
  sourceShown: boolean;
  onToggleSource: () => void;
}) {
  const [data, setData] = useState<StudyMapState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'map' | 'guide'>('map');
  const [now, setNow] = useState(() => Date.now());

  const start = useCallback(
    (rebuild: boolean) => {
      setErr(null);
      api<StudyMapState>(`/api/messages/${messageId}/concept-map`, { method: 'POST', json: { rebuild } }).then(setData, (e: Error) => setErr(e.message));
    },
    [messageId],
  );
  // Open the saved map, or start building one.
  useEffect(() => {
    let live = true;
    api<StudyMapState>(`/api/messages/${messageId}/concept-map`).then(
      (r) => {
        if (!live) return;
        if (r.state === 'none') start(false);
        else setData(r);
      },
      (e: Error) => live && setErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [messageId, start]);
  const building = data !== null && data.state !== 'none' && data.state !== 'done' && data.state !== 'failed';
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => {
      setNow(Date.now());
      api<StudyMapState>(`/api/messages/${messageId}/concept-map`).then(setData, () => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [building, messageId]);

  const numberOf = useMemo(() => (data?.state === 'done' ? sourceNumbers([...data.map.concepts.flatMap((c) => c.messages), ...data.map.guide.flatMap((g) => g.messages)]) : new Map<string, number>()), [data]);

  let body: React.ReactNode;
  if (err) body = <p role="alert" className="study-status">{err}</p>;
  else if (!data || data.state === 'none') body = <p className="study-status">Starting…</p>;
  else if (data.state === 'failed')
    body = (
      <div className="study-status">
        <p role="alert">{data.note ?? 'The concept map could not be built.'}</p>
        <button className="primary" onClick={() => start(true)}>
          Try again
        </button>
      </div>
    );
  else if (data.state !== 'done') {
    const at = Math.max(0, STEPS.findIndex((s) => s.state === data.state));
    const secs = Math.round((now - new Date(data.started_at).getTime()) / 1000);
    body = (
      <div className="study-status" role="status">
        <h3>NVIDIA Nemotron Ultra is building your concept map</h3>
        <ol className="study-steps">
          {STEPS.map((s, i) => (
            <li key={s.state} className={i < at ? 'done' : i === at && data.state !== 'pending' ? 'now' : ''}>
              {s.label}
            </li>
          ))}
        </ol>
        <p className="counts">{secs > 0 ? `${secs} s so far · ` : ''}usually 1–3 minutes. You can keep reading messages; it is saved when done.</p>
      </div>
    );
  } else if (tab === 'map') body = <MapPane map={data.map} sources={data.sources} numberOf={numberOf} onOpenMessage={onOpenMessage} />;
  else body = <GuidePane map={data.map} sources={data.sources} numberOf={numberOf} onOpenMessage={onOpenMessage} />;

  return (
    <div className="study-wrap" aria-label="Concept map">
      <ReactFlowProvider>{body}</ReactFlowProvider>
      <div className="study-bar">
        <button onClick={onBack}>← Back to mind map</button>
        <button aria-pressed={sourceShown} onClick={onToggleSource} title="Show or hide the message this concept map is about, in the right-hand panel">
          {sourceShown ? 'Hide source message' : 'Show source message'}
        </button>
        {data?.state === 'done' ? (
          <>
            <span className="seg" role="group" aria-label="Show">
              <button aria-pressed={tab === 'map'} onClick={() => setTab('map')}>
                Concept map
              </button>
              <button aria-pressed={tab === 'guide'} onClick={() => setTab('guide')}>
                Study guide
              </button>
            </span>
            <strong className="study-title" title={data.map.topic_path}>
              {data.map.title}
            </strong>
            <button onClick={() => start(true)} title="Build it again from the chat as it is now (uses Nemotron Ultra and web search again)">
              Rebuild
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
