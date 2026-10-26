'use client';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { layoutTree } from '../lib/layout';
import { formatCount } from '../lib/sizing';
import type { MapNode, MapResponse } from './types';

type CNodeData = { n: MapNode; selected: boolean; onOpen: (id: string) => void; onExpand: (n: MapNode) => void; minD: number };

function badgeText(n: MapNode) {
  if (n.matching_message_count === 0) return '0 messages';
  return `${formatCount(n.matching_message_count)}${n.matching_missed_count ? ` · ${n.matching_missed_count} missed` : ''}`;
}

const CountNode = memo(function CountNode({ data }: NodeProps<Node<CNodeData>>) {
  const { n, selected, onOpen, onExpand, minD } = data;
  const known = n.diameter !== null;
  const d = n.diameter ?? minD;
  const zero = known && n.matching_message_count === 0;
  const full = `${n.title} — ${known ? badgeText(n) : 'count loading'}`;
  return (
    <div className={`cnode root-${n.root} ${selected ? 'selected' : ''}`} title={full}>
      <Handle type="target" position={Position.Left} style={{ top: d / 2, opacity: 0, pointerEvents: 'none' }} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={{ top: d / 2, opacity: 0, pointerEvents: 'none' }} isConnectable={false} />
      <button
        className={`body ${zero ? 'zero' : ''} ${known ? '' : 'unknown'}`}
        style={{ width: d, height: d, padding: 0 }}
        aria-label={`Open ${full}`}
        onClick={() => onOpen(n.id)}
      >
        {known ? n.matching_message_count.toLocaleString('en-US') : '…'}
      </button>
      <div className="label">{n.title}</div>
      <div className="badge">
        {known ? (n.matching_message_count ? <span className={n.matching_missed_count ? 'missed' : 'readbadge'}>{n.matching_missed_count ? `${n.matching_missed_count} missed` : 'all read'}</span> : '0 messages') : 'loading'}
        {n.boundary ? (
          <button className="deeper" style={{ marginLeft: 6, padding: '0 6px', fontSize: 11 }} onClick={() => onExpand(n)} aria-label={`Show next level under ${n.title}`}>
            Show next level ▸
          </button>
        ) : null}
      </div>
    </div>
  );
});

const nodeTypes = { count: CountNode };

function Inner({ map, selectedId, onOpen, onExpand, chatKey }: { map: MapResponse; selectedId: string | null; onOpen: (id: string) => void; onExpand: (n: MapNode) => void; chatKey: string }) {
  const rf = useReactFlow();
  const prevPos = useRef(new Map<string, { x: number; y: number }>());
  const fitted = useRef<string | null>(null);
  const minD = map.sizing.min_diameter_px;

  const { nodes, edges } = useMemo(() => {
    const boxes = layoutTree(map.nodes.map((n) => ({ id: n.id, parentId: n.parent_id, diameter: n.diameter ?? minD, label: n.title })));
    const nodes: Node<CNodeData>[] = map.nodes.map((n) => {
      const b = boxes.get(n.id)!;
      return {
        id: n.id,
        type: 'count',
        position: { x: b.left, y: b.top },
        width: b.width,
        height: b.height,
        data: { n, selected: n.id === selectedId, onOpen, onExpand, minD },
        draggable: false,
        selectable: false,
        focusable: false,
        style: { width: b.width, display: 'flex', justifyContent: 'center', pointerEvents: 'all' },
      };
    });
    return { nodes, edges: map.edges.map((e) => ({ id: `${e.source}-${e.target}`, source: e.source, target: e.target, type: 'smoothstep' })) };
  }, [map, selectedId, onOpen, onExpand, minD]);

  // Preserve the camera; keep the selected node's screen anchor when sizes/positions change.
  useEffect(() => {
    if (fitted.current !== chatKey) {
      fitted.current = chatKey;
      requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 0, minZoom: 0.8, maxZoom: 1 }));
    } else if (selectedId) {
      const before = prevPos.current.get(selectedId);
      const now = nodes.find((n) => n.id === selectedId)?.position;
      if (before && now && (before.x !== now.x || before.y !== now.y)) {
        const vp = rf.getViewport();
        rf.setViewport({ x: vp.x - (now.x - before.x) * vp.zoom, y: vp.y - (now.y - before.y) * vp.zoom, zoom: vp.zoom });
      }
    }
    prevPos.current = new Map(nodes.map((n) => [n.id, n.position]));
  }, [nodes, selectedId, chatKey, rf]);

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.1} maxZoom={2.5} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
      <Background gap={24} size={1} />
      <Controls showInteractive={false} fitViewOptions={{ padding: 0.15, minZoom: 0.8, maxZoom: 1 }} />
    </ReactFlow>
  );
}

export function MapView(props: { map: MapResponse; selectedId: string | null; onOpen: (id: string) => void; onExpand: (n: MapNode) => void; chatKey: string }) {
  const s = props.map.sizing;
  const sample = [0, 10, 1000, s.reference_count];
  const D = (n: number) => Math.sqrt(s.min_diameter_px ** 2 + (s.max_diameter_px ** 2 - s.min_diameter_px ** 2) * Math.min(1, Math.log1p(n) / Math.log1p(s.reference_count)));
  return (
    <div style={{ position: 'absolute', inset: 0 }} aria-label="Topic map">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
      <div className="legend" aria-label="Size legend">
        <strong>{s.legend}</strong>
        <div className="dots">
          {sample.map((n) => (
            <div key={n} style={{ textAlign: 'center' }}>
              <div className="dot" style={{ width: D(n) / 4, height: D(n) / 4, margin: '0 auto' }} />
              <div>{n >= s.reference_count ? `${n.toLocaleString()}+` : n}</div>
            </div>
          ))}
        </div>
        <div className="counts">
          {props.map.visible_node_count}/{props.map.visible_node_budget} nodes shown{props.map.truncated_by_budget ? ' — more via focus or paging' : ''}
        </div>
      </div>
    </div>
  );
}
