// Deterministic validation of model taxonomy proposals against the stored tree.
// The application assigns IDs, derives depth and rejects cycles, scope errors,
// empty AI topics and unknown references. Model-supplied depth is never trusted.
import type { RootEnum, Tree } from '../graph/tree';
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
}

export interface TaxonomyPlan {
  newTopics: PlannedTopic[]; // parent-first order
  unitTargets: Map<string, { kind: 'existing'; id: string } | { kind: 'new'; key: string } | { kind: 'needs_review'; root: RootEnum }>;
  secondary: { messageRef: string; target: { kind: 'existing'; id: string } | { kind: 'new'; key: string } }[];
  rejected: string[];
}

const norm = (t: string) => t.normalize('NFKC').trim().toLocaleLowerCase('und');

/**
 * Validate a proposal. `allowedParents` restricts where new nodes may attach
 * (refinement of one branch); `allowedTargets` restricts unit assignment.
 */
export function validateTaxonomy(
  tree: Tree,
  proposal: Taxonomy,
  units: UnitInfo[],
  opts: { allowedParentIds?: Set<string>; allowedRefs?: Set<string>; defaultTarget?: string } = {},
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
  const emit = (key: string) => {
    if (alias.has(key)) return;
    const r = resolved.get(key);
    const n = byKey.get(key);
    if (!r || !n) return;
    if (r.parentRef.kind === 'new') emit(r.parentRef.key);
    const parentRef = r.parentRef.kind === 'new' ? alias.get(r.parentRef.key) : r.parentRef;
    if (!parentRef) return;
    const title = n.title.trim();
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

  return { newTopics: kept, unitTargets, secondary, rejected };
}

function isUnder(tree: Tree, id: string, allowed: Set<string>): boolean {
  let cur = tree.nodes.get(id);
  while (cur) {
    if (allowed.has(cur.id)) return true;
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : undefined;
  }
  return false;
}
