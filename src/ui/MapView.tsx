'use client';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutTree } from '../lib/layout';
import { formatCount } from '../lib/sizing';
import { RootIcon } from './RootIcon';
import type { MapNode, MapResponse } from './types';

// Branch toggle under a circle: how many topics it holds, and whether they are shown.
type Toggle = { open: boolean; count: number } | null;
type CNodeData = { n: MapNode; selected: boolean; onOpen: (id: string) => void; onToggle: (n: MapNode) => void; toggle: Toggle; minD: number };

function badgeText(n: MapNode) {
  if (n.matching_message_count === 0) return '0 messages';
  return `${formatCount(n.matching_message_count)}${n.matching_missed_count ? ` · ${n.matching_missed_count} missed` : ''}`;
}

const CountNode = memo(function CountNode({ data }: NodeProps<Node<CNodeData>>) {
  const { n, selected, onOpen, onToggle, toggle, minD } = data;
  const known = n.diameter !== null;
  const d = n.diameter ?? minD;
  const zero = known && n.matching_message_count === 0;
  const full = `${n.title} — ${known ? badgeText(n) : 'count loading'}`;
  // Topic and counts live inside the circle; text scales with it, and the
  // missed line is dropped where the circle is too small to hold three lines.
  const fit = (ratio: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, d * ratio)));
  const roomy = d >= 84;
  const isRoot = n.kind === 'CATEGORY';
  return (
    <div className={`cnode root-${n.root} ${selected ? 'selected' : ''}`} title={full}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} isConnectable={false} />
      <button
        className={`body ${zero ? 'zero' : ''} ${known ? '' : 'unknown'}`}
        style={{ width: d, height: d, padding: d * (isRoot ? 0.1 : 0.14) }}
        aria-label={`Open ${full}`}
        onClick={() => onOpen(n.id)}
      >
        {isRoot ? <RootIcon root={n.root} size={fit(0.2, 18, 40)} /> : null}
        {/* Narrower than the circle so wrapped lines stay inside its curved edge. */}
        <span className="title" style={{ fontSize: fit(0.12, 9, 16), WebkitLineClamp: !isRoot && roomy ? 3 : 2, width: Math.round(d * 0.72) }}>
          {n.title}
        </span>
        <span className="count" style={{ fontSize: fit(0.15, 11, 22) }}>
          {known ? n.matching_message_count.toLocaleString('en-US') : '…'}
        </span>
        {/* Roots also hold their icon, so their missed line needs a larger circle. */}
        {known && roomy && !(isRoot && d < 150) && n.matching_message_count ? (
          <span className={n.matching_missed_count ? 'missed' : 'readbadge'} style={{ fontSize: fit(0.09, 10, 13) }}>
            {n.matching_missed_count ? `${n.matching_missed_count} missed` : 'all read'}
          </span>
        ) : null}
      </button>
      {toggle ? (
        <button className="deeper" aria-expanded={toggle.open} onClick={() => onToggle(n)} aria-label={`${toggle.open ? 'Hide' : 'Show'} topics under ${n.title}`}>
          {toggle.open ? '▴ Hide' : `▾ ${toggle.count} ${toggle.count === 1 ? 'topic' : 'topics'}`}
        </button>
      ) : null}
    </div>
  );
});

const nodeTypes = { count: CountNode };

type Props = { map: MapResponse; selectedId: string | null; onOpen: (id: string) => void; onExpand: (n: MapNode) => void; chatKey: string };

function Inner({ map, selectedId, onOpen, onExpand, chatKey }: Props) {
  const rf = useReactFlow();
  const prevPos = useRef(new Map<string, { x: number; y: number }>());
  const anchor = useRef<string | null>(null);
  const fitted = useRef<string | null>(null);
  const minD = map.sizing.min_diameter_px;
  // Branches open one at a time: only what the reader opened is shown.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map.nodes]);
  const kidsOf = useMemo(() => {
    const m = new Map<string, MapNode[]>();
    for (const n of map.nodes) if (n.parent_id && byId.has(n.parent_id)) m.set(n.parent_id, [...(m.get(n.parent_id) ?? []), n]);
    return m;
  }, [map.nodes, byId]);

  // A node opened elsewhere (Ask, search, a link) opens the branches above it.
  const [revealed, setRevealed] = useState<string | null>(null);
  if (selectedId !== revealed) {
    setRevealed(selectedId);
    const up: string[] = [];
    for (let p = selectedId ? byId.get(selectedId)?.parent_id : null; p && byId.has(p); p = byId.get(p)!.parent_id) up.push(p);
    if (up.some((id) => !expanded.has(id))) setExpanded(new Set([...expanded, ...up]));
  }

  const onToggle = useCallback(
    (n: MapNode) => {
      anchor.current = n.id;
      setExpanded((cur) => {
        const next = new Set(cur);
        if (next.has(n.id)) next.delete(n.id);
        else next.add(n.id);
        return next;
      });
      // Children not loaded yet: fetch one more level.
      if (!kidsOf.has(n.id) && n.boundary) onExpand(n);
    },
    [kidsOf, onExpand],
  );

  const { nodes, edges } = useMemo(() => {
    const visible = map.nodes.filter((n) => {
      for (let p = n.parent_id; p && byId.has(p); p = byId.get(p)!.parent_id) if (!expanded.has(p)) return false;
      return true;
    });
    const shown = new Set(visible.map((n) => n.id));
    const boxes = layoutTree(
      visible.map((n) => ({ id: n.id, parentId: n.parent_id, diameter: n.diameter ?? minD, label: n.title })),
      'down',
    );
    const nodes: Node<CNodeData>[] = visible.map((n) => {
      const b = boxes.get(n.id)!;
      const count = kidsOf.get(n.id)?.length || n.child_topic_count;
      const toggle: Toggle = count > 0 || n.boundary ? { open: expanded.has(n.id), count } : null;
      return {
        id: n.id,
        type: 'count',
        position: { x: b.left, y: b.top },
        width: b.width,
        height: b.height,
        data: { n, selected: n.id === selectedId, onOpen, onToggle, toggle, minD },
        draggable: false,
        selectable: false,
        focusable: false,
        style: { width: b.width, display: 'flex', justifyContent: 'center', pointerEvents: 'all' },
      };
    });
    const edges = map.edges.filter((e) => shown.has(e.source) && shown.has(e.target)).map((e) => ({ id: `${e.source}-${e.target}`, source: e.source, target: e.target, type: 'default' }));
    return { nodes, edges };
  }, [map, byId, kidsOf, expanded, selectedId, onOpen, onToggle, minD]);

  // Preserve the camera; keep the toggled (or selected) node's screen anchor when positions change.
  useEffect(() => {
    // Centre once per chat, but only when there is something to centre on: a chat
    // opened before its analysis finished would otherwise keep the empty view.
    if (fitted.current !== chatKey && nodes.length) {
      fitted.current = chatKey;
      requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 0, minZoom: 0.8, maxZoom: 1 }));
    } else if (fitted.current === chatKey) {
      const id = anchor.current ?? selectedId;
      const before = id ? prevPos.current.get(id) : undefined;
      const now = id ? nodes.find((n) => n.id === id)?.position : undefined;
      if (before && now && (before.x !== now.x || before.y !== now.y)) {
        const vp = rf.getViewport();
        rf.setViewport({ x: vp.x - (now.x - before.x) * vp.zoom, y: vp.y - (now.y - before.y) * vp.zoom, zoom: vp.zoom });
      }
    }
    prevPos.current = new Map(nodes.map((n) => [n.id, n.position]));
  }, [nodes, selectedId, chatKey, rf]);

  const parents = map.nodes.filter((n) => kidsOf.has(n.id));
  // Double-click (or the button) brings the whole visible map back into view.
  const recentre = () => rf.fitView({ padding: 0.15, duration: 300, maxZoom: 1 });
  return (
    <div style={{ position: 'absolute', inset: 0 }} onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && recentre()}>
      <div className="map-tools" role="toolbar" aria-label="Branches">
        <button onClick={recentre} title="Fit the map in view (or double-click the map)">
          ⌖ Re-centre
        </button>
        <button onClick={() => setExpanded(new Set(parents.map((n) => n.id)))}>Expand all</button>
        <button
          onClick={() => {
            anchor.current = null;
            setExpanded(new Set());
            requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 300, minZoom: 0.8, maxZoom: 1 }));
          }}
        >
          Collapse all
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        minZoom={0.1}
        maxZoom={2.5}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} fitViewOptions={{ padding: 0.15, maxZoom: 1 }} />
      </ReactFlow>
    </div>
  );
}

export function MapView(props: Props) {
  return (
    <div style={{ position: 'absolute', inset: 0 }} aria-label="Topic map">
      <ReactFlowProvider>
        {/* A new chat starts with its branches closed. */}
        <Inner key={props.chatKey} {...props} />
      </ReactFlowProvider>
      {/* No size legend over the map: it hid too much of it. Only say so when topics are hidden. */}
      {props.map.truncated_by_budget ? (
        <div className="map-note" role="status">
          Some topics are hidden — focus a branch to see more
        </div>
      ) : null}
    </div>
  );
}
