// Deterministic, size-aware tidy-tree layout (left to right, or top down). Each node
// reserves its actual circle diameter (topic and counts are drawn inside it)
// plus room for the "Show next level" control below, so settled layouts cannot overlap. No physics simulation; identical input gives
// identical output, which keeps the camera and selection stable.

export interface LayoutInput {
  id: string;
  parentId: string | null;
  diameter: number; // logical body diameter (unknown counts use the minimum placeholder)
  label: string;
  badge?: string;
}

export interface LayoutBox {
  id: string;
  x: number; // circle centre
  y: number;
  diameter: number;
  // Full reserved bounds (circle + expand control below) in graph coordinates.
  left: number;
  top: number;
  width: number;
  height: number;
}

export const BADGE_HEIGHT = 18;
const H_GAP = 72;
const V_GAP = 18;

// Width of the "Show next level ▸" control that may sit under a circle.
export const EXPAND_CONTROL_WIDTH = 112;

export function boxSize(n: Pick<LayoutInput, 'diameter' | 'label'>) {
  return { width: Math.max(n.diameter, EXPAND_CONTROL_WIDTH), height: n.diameter + 4 + BADGE_HEIGHT };
}

/**
 * 'right': levels are columns, siblings stack downwards (the original layout).
 * 'down': levels are rows, siblings spread sideways, so a wide screen holds a wide map.
 */
export type LayoutDirection = 'right' | 'down';

export function layoutTree(nodes: LayoutInput[], direction: LayoutDirection = 'right'): Map<string, LayoutBox> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, LayoutInput[]>();
  const roots: LayoutInput[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const list = children.get(n.parentId) ?? [];
      list.push(n);
      children.set(n.parentId, list);
    } else roots.push(n);
  }
  // Laid out on abstract axes: "main" runs across levels, "cross" across siblings.
  const down = direction === 'down';
  const size = (n: LayoutInput) => {
    const b = boxSize(n);
    return down ? { main: b.height, cross: b.width } : { main: b.width, cross: b.height };
  };
  const mainGap = down ? V_GAP * 3 : H_GAP;
  const crossGap = down ? H_GAP / 3 : V_GAP;
  // Level = depth within the rendered forest.
  const level = new Map<string, number>();
  const visit = (n: LayoutInput, d: number) => {
    level.set(n.id, d);
    for (const c of children.get(n.id) ?? []) visit(c, d + 1);
  };
  roots.forEach((r) => visit(r, 0));
  const levelSize: number[] = [];
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    levelSize[l] = Math.max(levelSize[l] ?? 0, size(n).main);
  }
  const levelStart: number[] = [];
  let acc = 0;
  for (let i = 0; i < levelSize.length; i++) {
    levelStart[i] = acc;
    acc += (levelSize[i] ?? 0) + mainGap;
  }

  // Abstract placement: cross offset of each box's leading edge.
  const crossAt = new Map<string, number>();
  // Returns the cross extent end used by the subtree.
  const place = (n: LayoutInput, start: number): number => {
    const sz = size(n);
    const kids = children.get(n.id) ?? [];
    let cursor = start;
    for (const c of kids) cursor = place(c, cursor) + crossGap;
    const kidsEnd = kids.length ? cursor - crossGap : start;
    const kidsSpan = kidsEnd - start;
    let boxStart: number;
    if (!kids.length || sz.cross >= kidsSpan) {
      boxStart = start;
      if (kids.length && sz.cross > kidsSpan) {
        // Centre the children against a larger parent box.
        const shift = (sz.cross - kidsSpan) / 2;
        for (const id of subtreeIds(kids, children)) crossAt.set(id, crossAt.get(id)! + shift);
      }
    } else {
      boxStart = start + kidsSpan / 2 - sz.cross / 2;
    }
    crossAt.set(n.id, boxStart);
    return Math.max(boxStart + sz.cross, kidsEnd);
  };
  let c = 0;
  for (const r of roots) c = place(r, c) + crossGap * 2;

  const out = new Map<string, LayoutBox>();
  for (const n of nodes) {
    const b = boxSize(n);
    const l = level.get(n.id) ?? 0;
    const cross = crossAt.get(n.id)!;
    // Centre each box within its level band along the main axis.
    if (down) {
      const top = levelStart[l];
      out.set(n.id, { id: n.id, x: cross + b.width / 2, y: top + n.diameter / 2, diameter: n.diameter, left: cross, top, width: b.width, height: b.height });
    } else {
      const x = levelStart[l] + levelSize[l] / 2;
      out.set(n.id, { id: n.id, x, y: cross + n.diameter / 2, diameter: n.diameter, left: x - b.width / 2, top: cross, width: b.width, height: b.height });
    }
  }
  return out;
}

function subtreeIds(kids: LayoutInput[], children: Map<string, LayoutInput[]>): string[] {
  const out: string[] = [];
  const st = [...kids];
  while (st.length) {
    const k = st.pop()!;
    out.push(k.id);
    st.push(...(children.get(k.id) ?? []));
  }
  return out;
}
/** Pairs of reserved boxes that intersect (should be empty for any layout). */
export function overlaps(boxes: Iterable<LayoutBox>): [string, string][] {
  const list = [...boxes].sort((a, b) => a.left - b.left);
  const out: [string, string][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j].left < list[i].left + list[i].width; j++) {
      const a = list[i];
      const b = list[j];
      if (a.top < b.top + b.height && b.top < a.top + a.height) out.push([a.id, b.id]);
    }
  }
  return out;
}
