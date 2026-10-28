'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapNode, MapResponse } from './types';

const ROW = 32;

/** Accessible outline: constant row height, exact counts, keyboard navigation, windowed rendering. */
export function OutlineView({ map, selectedId, onOpen, onExpand }: { map: MapResponse; selectedId: string | null; onOpen: (id: string) => void; onExpand: (n: MapNode) => void }) {
  const rows = useMemo(() => {
    const kids = new Map<string | null, MapNode[]>();
    const ids = new Set(map.nodes.map((n) => n.id));
    for (const n of map.nodes) {
      const p = n.parent_id && ids.has(n.parent_id) ? n.parent_id : null;
      kids.set(p, [...(kids.get(p) ?? []), n]);
    }
    const out: MapNode[] = [];
    const walk = (p: string | null) => {
      for (const n of kids.get(p) ?? []) {
        out.push(n);
        walk(n.id);
      }
    };
    walk(null);
    return out;
  }, [map]);
  const [scroll, setScroll] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scroll / ROW) - 5);
  const end = Math.min(rows.length, start + Math.ceil(height / ROW) + 10);
  const maxD = map.sizing.max_diameter_px;

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const move = (j: number) => {
      const el = ref.current?.querySelector<HTMLElement>(`[data-row="${j}"]`);
      if (el) el.focus();
      else ref.current?.scrollTo({ top: j * ROW });
    };
    if (e.key === 'ArrowDown') move(Math.min(rows.length - 1, i + 1));
    if (e.key === 'ArrowUp') move(Math.max(0, i - 1));
    if (e.key === 'Enter') onOpen(rows[i].id);
    if (e.key === 'ArrowRight' && rows[i].boundary) onExpand(rows[i]);
  };

  return (
    <div className="outline" ref={ref} role="tree" aria-label="Topic outline" onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * ROW, position: 'relative' }}>
        {rows.slice(start, end).map((n, k) => {
          const i = start + k;
          return (
            <div
              key={n.id}
              data-row={i}
              role="treeitem"
              aria-level={n.depth + 1}
              aria-selected={n.id === selectedId}
              tabIndex={0}
              className="orow"
              style={{ position: 'absolute', top: i * ROW, left: 0, right: 0, paddingLeft: 8 + n.depth * 18 }}
              onClick={() => onOpen(n.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="marker" aria-hidden style={{ width: 6 + (n.diameter ?? 0) / maxD * 12, height: 6 + (n.diameter ?? 0) / maxD * 12 }} />
              <span className="t">
                {n.title}
              </span>
              <span className="counts">
                {n.matching_message_count.toLocaleString('en-US')} msg{n.matching_missed_count ? <span className="missed"> · {n.matching_missed_count} missed</span> : null}
              </span>
              {n.boundary ? (
                <button style={{ fontSize: 11, padding: '0 6px' }} onClick={(e) => (e.stopPropagation(), onExpand(n))}>
                  next level
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
