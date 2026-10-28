// Deterministic validation of model taxonomy proposals against the stored tree.
// The application assigns IDs, derives depth and rejects cycles, scope errors,
// empty AI topics and unknown references. Model-supplied depth is never trusted.
import type { RootEnum, Tree } from '../graph/tree';
import { MAX_CHILD_TOPICS } from './prompts';
import type { Taxonomy } from './schemas';

export interface UnitInfo {
  unitKey: string;
  primaryRoot: RootEnum;
  messageRefs: string[];
}

export interface PlannedTopic {
  key: string;
  parentRef: { kind: 'existing'; id: string } | { kind: 'new'; key: string };
  root: RootEnum;
  title: string;
  aliases: string[];
  maySubdivide: boolean;
  /** The model proposed narrower topics here, held back until this level is refined. */
  narrower?: boolean;
}

export interface TaxonomyPlan {
  newTopics: PlannedTopic[]; // parent-first order
  unitTargets: Map<string, { kind: 'existing'; id: string } | { kind: 'new'; key: string } | { kind: 'needs_review'; root: RootEnum }>;
  secondary: { messageRef: string; target: { kind: 'existing'; id: string } | { kind: 'new'; key: string } }[];
  rejected: string[];
  /** Existing topics the model wanted narrower levels under: refined next, one level at a time. */
  subdivideExisting: string[];
}

const norm = (t: string) => t.normalize('NFKC').trim().toLocaleLowerCase('und');

/**
 * Validate a proposal. `allowedParents` restricts where new nodes may attach
 * (refinement of one branch); `allowedTargets` restricts unit assignment.
 */
const titleWords = (x: string) =>
  x
    .toLocaleLowerCase('und')
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** Titles that say the same thing ("Software Development" / "software development's" / "Software developments"). */
export function sameSubject(a: string, b: string): boolean {
  // "Knowledge Root" under the Knowledge root is the root again.
  const key = (x: string) => titleWords(x).filter((w) => w !== 'root').join(' ');
  return key(a) === key(b);
}

const FILLER = new Set(['and', 'the', 'for', 'with', 'about', 'other', 'general', 'misc', 'miscellaneous', 'topic', 'related']);

const meaningful = (x: string) => new Set(titleWords(x).filter((w) => w.length > 2 && !FILLER.has(w)));

/**
 * A subtopic that repeats its parent's subject without narrowing it: they share
 * a meaningful word, but the child does not keep all of the parent's words and
 * add its own ("Development Tools & Practices" > "Testing & Development Tools",
 * "Software Development" > "Development"). "Books" > "Programming books" is a
 * real narrowing and does not count.
 */
export function overlappingSubject(parent: string, child: string): boolean {
  const p = meaningful(parent);
  const c = meaningful(child);
  const shared = [...c].some((w) => p.has(w));
  const narrows = [...p].every((w) => c.has(w)) && c.size > p.size;
  return shared && !narrows;
}

/** Whether a model-proposed title can name a topic: it must contain a letter or digit. */
export function isTopicTitle(title: string): boolean {
  return /[\p{L}\p{N}]/u.test(title);
}

export function validateTaxonomy(
  tree: Tree,
  proposal: Taxonomy,
  units: UnitInfo[],
  opts: {
    allowedParentIds?: Set<string>;
    allowedRefs?: Set<string>;
    defaultTarget?: string;
    /** The map is built top-down, one level at a time: new topics may only attach to these. */
    newParentIds?: Set<string>;
    /** New topics may not be nested under other new topics in the same answer. */
    oneLevel?: boolean;
  } = {},
): TaxonomyPlan {
  const rejected: string[] = [];
  const rootIds: Record<string, string> = {};
  for (const r of tree.roots) rootIds[`ROOT:${r.root}`] = r.id;

  const byKey = new Map<string, (typeof proposal.nodes)[number]>();
  for (const n of proposal.nodes) {
    if (byKey.has(n.key) || tree.nodes.has(n.key) || n.key.startsWith('ROOT:')) {
      rejected.push(`duplicate or reserved node key ${n.key}`);
      continue;
    }
    byKey.set(n.key, n);
  }

  // Resolve each proposed node's parent and root; detect cycles among new keys.
  type Resolved = { parentRef: PlannedTopic['parentRef']; root: RootEnum };
  const resolved = new Map<string, Resolved | null>();
  const resolving = new Set<string>();
  const resolve = (key: string): Resolved | null => {
    if (resolved.has(key)) return resolved.get(key)!;
    if (resolving.has(key)) {
      rejected.push(`cycle through ${key}`);
      return null;
    }
    const n = byKey.get(key);
    if (!n) return null;
    resolving.add(key);
    let out: Resolved | null = null;
    const parentExisting = rootIds[n.parent] ?? (tree.nodes.has(n.parent) ? n.parent : undefined);
    if (parentExisting) {
      if (opts.allowedParentIds && !opts.allowedParentIds.has(parentExisting)) {
        rejected.push(`node ${key} attaches outside the permitted branch`);
      } else {
        out = { parentRef: { kind: 'existing', id: parentExisting }, root: tree.nodes.get(parentExisting)!.root };
      }
    } else if (byKey.has(n.parent)) {
      const p = resolve(n.parent);
      if (p) out = { parentRef: { kind: 'new', key: n.parent }, root: p.root };
    } else {
      rejected.push(`node ${key} has unknown parent ${n.parent}`);
    }
    resolving.delete(key);
    resolved.set(key, out);
    return out;
  };
  for (const k of byKey.keys()) resolve(k);

  // Reuse existing same-title children instead of duplicating them (title is
  // not identity in general, but a duplicate sibling would be redundant).
  const alias = new Map<string, { kind: 'existing'; id: string } | { kind: 'new'; key: string }>();
  const ordered: PlannedTopic[] = [];
  // Hard limit, never exceeded even for a moment: a parent holds at most MAX_CHILD_TOPICS topics.
  const childCount = new Map<string, number>();
  const subdivideExisting = new Set<string>();
  const countKey = (p: { kind: 'existing'; id: string } | { kind: 'new'; key: string }) => (p.kind === 'existing' ? `e:${p.id}` : `n:${p.key}`);
  const childrenOf = (p: { kind: 'existing'; id: string } | { kind: 'new'; key: string }) => {
    const k = countKey(p);
    if (!childCount.has(k)) childCount.set(k, p.kind === 'existing' ? (tree.nodes.get(p.id)?.childIds ?? []).filter((c) => !tree.nodes.get(c)?.needsReview).length : 0);
    return childCount.get(k)!;
  };
  const emit = (key: string) => {
    if (alias.has(key)) return;
    const r = resolved.get(key);
    const n = byKey.get(key);
    if (!r || !n) return;
    if (r.parentRef.kind === 'new') emit(r.parentRef.key);
    const parentRef = r.parentRef.kind === 'new' ? alias.get(r.parentRef.key) : r.parentRef;
    if (!parentRef) return;
    // Top-down: a level is built before the one beneath it. A topic proposed deeper than the level
    // being built gives its discussions to its parent; they are split out when that parent is refined.
    if ((opts.oneLevel && parentRef.kind === 'new') || (parentRef.kind === 'existing' && opts.newParentIds && !opts.newParentIds.has(parentRef.id))) {
      alias.set(key, parentRef);
      // The model saw narrower subjects here: split the parent next.
      if (parentRef.kind === 'new') {
        const p = ordered.find((o) => o.key === parentRef.key);
        if (p) p.maySubdivide = p.narrower = true;
      } else subdivideExisting.add(parentRef.id);
      return;
    }
    const title = n.title.trim();
    // A title with no letters or digits (e.g. "}],", a fragment of the model's JSON) is not a
    // topic: its units and subtopics go to its parent instead.
    if (!isTopicTitle(title)) {
      alias.set(key, parentRef);
      return;
    }
    // A child titled like its parent ("Software Development" under "Software Development") adds no level.
    const parentTitle = parentRef.kind === 'existing' ? tree.nodes.get(parentRef.id)?.title : ordered.find((o) => o.key === parentRef.key)?.title;
    if (parentTitle && sameSubject(title, parentTitle)) {
      alias.set(key, parentRef);
      return;
    }
    if (parentRef.kind === 'existing') {
      const parent = tree.nodes.get(parentRef.id)!;
      const same = parent.childIds.map((c) => tree.nodes.get(c)!).find((c) => norm(c.title) === norm(title));
      if (same) {
        alias.set(key, { kind: 'existing', id: same.id });
        return;
      }
    } else {
      const sib = ordered.find((t) => t.parentRef.kind === 'new' && t.parentRef.key === parentRef.key && norm(t.title) === norm(title));
      if (sib) {
        alias.set(key, { kind: 'new', key: sib.key });
        return;
      }
    }
    // A full level takes no more topics: the discussions stay on the parent, to be placed in (or
    // beneath) its existing topics.
    if (childrenOf(parentRef) >= MAX_CHILD_TOPICS) {
      alias.set(key, parentRef);
      return;
    }
    childCount.set(countKey(parentRef), childrenOf(parentRef) + 1);
    ordered.push({ key, parentRef, root: r.root, title, aliases: n.aliases, maySubdivide: n.may_subdivide });
    alias.set(key, { kind: 'new', key });
  };
  for (const k of byKey.keys()) emit(k);

  const target = (t: string) => {
    if (rootIds[t]) return { kind: 'existing' as const, id: rootIds[t] };
    if (tree.nodes.has(t)) return { kind: 'existing' as const, id: t };
    return alias.get(t);
  };
  const rootOf = (t: { kind: 'existing'; id: string } | { kind: 'new'; key: string }): RootEnum =>
    t.kind === 'existing' ? tree.nodes.get(t.id)!.root : ordered.find((o) => o.key === t.key)!.root;

  const unitTargets: TaxonomyPlan['unitTargets'] = new Map();
  const unitByKey = new Map(units.map((u) => [u.unitKey, u]));
  for (const a of proposal.assignments) {
    const u = unitByKey.get(a.unit_key);
    if (!u) {
      rejected.push(`assignment for unknown unit ${a.unit_key}`);
      continue;
    }
    if (unitTargets.has(u.unitKey)) continue;
    const t = target(a.topic);
    if (!t) {
      rejected.push(`unit ${u.unitKey} assigned to unknown topic`);
      continue;
    }
    if (t.kind === 'existing' && opts.allowedParentIds && !opts.allowedParentIds.has(t.id) && !isUnder(tree, t.id, opts.allowedParentIds)) {
      rejected.push(`unit ${u.unitKey} assigned outside the branch`);
      continue;
    }
    if (rootOf(t) !== u.primaryRoot) {
      rejected.push(`unit ${u.unitKey} assigned across roots`);
      unitTargets.set(u.unitKey, { kind: 'needs_review', root: u.primaryRoot });
      continue;
    }
    unitTargets.set(u.unitKey, t);
  }
  for (const u of units) {
    if (!unitTargets.has(u.unitKey)) {
      unitTargets.set(u.unitKey, opts.defaultTarget ? { kind: 'existing', id: opts.defaultTarget } : { kind: 'needs_review', root: u.primaryRoot });
    }
  }

  const secondary: TaxonomyPlan['secondary'] = [];
  for (const sp of proposal.secondary_placements) {
    if (opts.allowedRefs && !opts.allowedRefs.has(sp.message_ref)) {
      rejected.push(`secondary placement for unknown ref ${sp.message_ref}`);
      continue;
    }
    const t = target(sp.topic);
    if (!t) {
      rejected.push('secondary placement to unknown topic');
      continue;
    }
    secondary.push({ messageRef: sp.message_ref, target: t });
  }

  // Drop new topics with no assigned content anywhere in their new subtree.
  const used = new Set<string>();
  const markUp = (key: string) => {
    let cur: PlannedTopic | undefined = ordered.find((o) => o.key === key);
    while (cur && !used.has(cur.key)) {
      used.add(cur.key);
      cur = cur.parentRef.kind === 'new' ? ordered.find((o) => o.key === (cur!.parentRef as { key: string }).key) : undefined;
    }
  };
  for (const t of unitTargets.values()) if (t.kind === 'new') markUp(t.key);
  for (const sp of secondary) if (sp.target.kind === 'new') markUp(sp.target.key);
  const kept = ordered.filter((o) => {
    if (!used.has(o.key)) rejected.push(`empty topic ${o.title} dropped`);
    return used.has(o.key);
  });

  return { newTopics: kept, unitTargets, secondary, rejected, subdivideExisting: [...subdivideExisting] };
}

function isUnder(tree: Tree, id: string, allowed: Set<string>): boolean {
  let cur = tree.nodes.get(id);
  while (cur) {
    if (allowed.has(cur.id)) return true;
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : undefined;
  }
  return false;
}
