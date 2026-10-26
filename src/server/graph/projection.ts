// Map projection: chooses which stored topic nodes to render under a display
// depth bound, collapse state, branch focus, child pagination and a visible-node
// budget. It reads persisted state only and never calls a model. Counts come
// from the content-filter contract and are independent of this projection.
import type { ViewConfig } from '../../lib/config';
import { SIZE_LEGEND, sizingRevision } from '../../lib/sizing';
import type { CountSnapshot } from './counts';
import type { DisplayDepth } from './filters';
import { ancestors, pathOf, type Tree, type TreeNode } from './tree';

export interface DiscussionRow {
  id: string;
  topicId: string;
  title: string;
}

export interface ProjectionInput {
  tree: Tree;
  discussions: DiscussionRow[];
  counts: CountSnapshot;
  depth: DisplayDepth;
  collapsed: Set<string>;
  focusId?: string | null;
  childOffsets: Record<string, number>;
  showDiscussions: boolean;
  selectedTopicIds: string[];
  filterActive: boolean;
  view: ViewConfig;
  childPageSize?: number;
}

export interface MapNode {
  id: string;
  kind: 'CATEGORY' | 'TOPIC' | 'DISCUSSION';
  root: string;
  parent_id: string | null;
  title: string;
  depth: number;
  matching_message_count: number;
  matching_missed_count: number;
  child_topic_count: number;
  children_shown: number;
  next_child_offset: number | null;
  boundary: boolean;
  has_deeper_topics: boolean;
  collapsed: boolean;
  needs_review: boolean;
  discussion_count: number;
}

export interface MapProjection {
  nodes: MapNode[];
  edges: { source: string; target: string }[];
  available_max_topic_depth: number;
  max_topic_depth: DisplayDepth;
  effective_depth: number;
  visible_node_budget: number;
  visible_node_count: number;
  truncated_by_budget: boolean;
  focus: { id: string; breadcrumbs: { id: string; title: string; depth: number }[] } | null;
  hidden_selected_topics: { id: string; path: { id: string; title: string; depth: number }[]; visible_ancestor_id: string | null }[];
  sizing: { min_diameter_px: number; max_diameter_px: number; reference_count: number; revision: string; legend: string };
}

const byTitle = (a: TreeNode, b: TreeNode) => a.title.localeCompare(b.title, 'en') || a.id.localeCompare(b.id);

export function projectMap(input: ProjectionInput): MapProjection {
  const { tree, counts, view } = input;
  const budget = view.maxVisibleNodes;
  const childPage = input.childPageSize ?? 50;
  const bound = input.depth === 'all' ? Number.POSITIVE_INFINITY : input.depth;
  const effectiveDepth = Math.min(bound, tree.maxDepth);

  const countOf = (id: string) => counts.topics.get(id) ?? { total: 0, missed: 0 };
  const discByTopic = new Map<string, DiscussionRow[]>();
  for (const d of input.discussions) {
    const list = discByTopic.get(d.topicId) ?? [];
    list.push(d);
    discByTopic.set(d.topicId, list);
  }

  // Nodes that must stay visible regardless of a zero filtered count: roots,
  // focus chain and the visible ancestors of selected (possibly hidden) topics.
  const pinned = new Set<string>(tree.roots.map((r) => r.id));
  const focus = input.focusId ? tree.nodes.get(input.focusId) : undefined;
  if (focus) for (const a of ancestors(tree, focus.id)) pinned.add(a.id);
  for (const t of input.selectedTopicIds) {
    for (const a of ancestors(tree, t)) if (a.depth <= bound) pinned.add(a.id);
  }

  const include = (n: TreeNode) => pinned.has(n.id) || !input.filterActive || countOf(n.id).total > 0 || n.kind === 'CATEGORY';
  const visibleChildren = (n: TreeNode) =>
    n.childIds
      .map((c) => tree.nodes.get(c)!)
      .filter(include)
      .sort(byTitle);

  const out: MapNode[] = [];
  const edges: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const push = (n: TreeNode) => {
    const c = countOf(n.id);
    const kids = visibleChildren(n);
    const node: MapNode = {
      id: n.id,
      kind: n.kind,
      root: n.root,
      parent_id: n.parentId,
      title: n.title,
      depth: n.depth,
      matching_message_count: c.total,
      matching_missed_count: c.missed,
      child_topic_count: kids.length,
      children_shown: 0,
      next_child_offset: null,
      boundary: n.depth >= bound && kids.length > 0,
      has_deeper_topics: kids.length > 0,
      collapsed: input.collapsed.has(n.id),
      needs_review: n.needsReview,
      discussion_count: discByTopic.get(n.id)?.length ?? 0,
    };
    out.push(node);
    seen.add(n.id);
    if (n.parentId && seen.has(n.parentId)) edges.push({ source: n.parentId, target: n.id });
    return { node, kids };
  };

  // Start from the focused branch (depths are never renumbered) or the roots.
  const start = focus ? [focus] : tree.roots;
  const queue: { n: TreeNode; node: MapNode; kids: TreeNode[] }[] = [];
  for (const r of start) {
    if (out.length >= budget) {
      truncated = true;
      break;
    }
    const p = push(r);
    queue.push({ n: r, ...p });
  }
  // Breadth-first: shallow levels render first (progressive loading under All).
  for (let qi = 0; qi < queue.length; qi++) {
    const { n, node, kids } = queue[qi];
    if (n.depth >= bound || input.collapsed.has(n.id) || kids.length === 0) continue;
    const offset = Math.max(0, Math.min(input.childOffsets[n.id] ?? 0, kids.length));
    const page = kids.slice(offset, offset + childPage);
    for (const k of page) {
      if (out.length >= budget) {
        truncated = true;
        break;
      }
      const p = push(k);
      node.children_shown++;
      queue.push({ n: k, ...p });
    }
    const consumed = offset + node.children_shown;
    node.next_child_offset = consumed < kids.length ? consumed : null;
  }

  if (input.showDiscussions) {
    for (const { n } of queue) {
      for (const d of discByTopic.get(n.id) ?? []) {
        if (out.length >= budget) {
          truncated = true;
          break;
        }
        const c = counts.discussions.get(d.id) ?? { total: 0, missed: 0 };
        if (input.filterActive && c.total === 0) continue;
        out.push({
          id: d.id,
          kind: 'DISCUSSION',
          root: n.root,
          parent_id: n.id,
          title: d.title,
          depth: n.depth,
          matching_message_count: c.total,
          matching_missed_count: c.missed,
          child_topic_count: 0,
          children_shown: 0,
          next_child_offset: null,
          boundary: false,
          has_deeper_topics: false,
          collapsed: false,
          needs_review: false,
          discussion_count: 0,
        });
        edges.push({ source: n.id, target: d.id });
      }
    }
  }

  const hidden = input.selectedTopicIds
    .filter((id) => tree.nodes.has(id) && !seen.has(id))
    .map((id) => {
      const chain = ancestors(tree, id);
      const visibleAncestor = [...chain].reverse().find((a) => seen.has(a.id));
      return { id, path: pathOf(tree, id), visible_ancestor_id: visibleAncestor?.id ?? null };
    });

  return {
    nodes: out,
    edges,
    available_max_topic_depth: tree.maxDepth,
    max_topic_depth: input.depth,
    effective_depth: effectiveDepth,
    visible_node_budget: budget,
    visible_node_count: out.length,
    truncated_by_budget: truncated,
    focus: focus ? { id: focus.id, breadcrumbs: pathOf(tree, focus.id) } : null,
    hidden_selected_topics: hidden,
    sizing: {
      min_diameter_px: view.sizing.minDiameterPx,
      max_diameter_px: view.sizing.maxDiameterPx,
      reference_count: view.sizing.referenceCount,
      revision: sizingRevision(view.sizing),
      legend: SIZE_LEGEND,
    },
  };
}
