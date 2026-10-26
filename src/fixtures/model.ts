// FixtureModelProvider: deterministic stand-in for Nemotron used in local
// development, tests and the isolated public demo. It answers from the fixture
// manifest, emulating bounded output (at most two new levels per call) so the
// real refinement-frontier machinery is exercised. Its runs are recorded with
// provider='fixture' and can never satisfy the A18 live-inference gate.
import type { CompletionRequest, CompletionResult, ModelProvider, Role } from '../server/ai/provider';
import type { Manifest, ManifestMessage } from './generate';

const ROOT_OF_LETTER: Record<string, string> = { K: 'KNOWLEDGE', G: 'GENERAL_CHAT', R: 'RESOURCES' };
const LETTER_OF_TITLE: Record<string, string> = { Knowledge: 'K', 'General Chat': 'G', Resources: 'R' };
const LEVELS_PER_CALL = 2;

const pathOfKey = (key: string) => key.slice(key.indexOf(':') + 1);
const segs = (p: string) => p.split('/');

export class FixtureModelProvider implements ModelProvider {
  readonly kind = 'fixture' as const;
  private byNative = new Map<string, ManifestMessage>();
  calls = 0;

  constructor(private manifest: Manifest) {
    for (const m of manifest.messages) this.byNative.set(m.nativeId, m);
  }

  modelIdFor(role: Role): string {
    return `fixture-${role}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const op = req.operation.replace(/:repair$|:escalate$/, '');
    const input = JSON.parse(req.user.split('\n\nPREVIOUS_OUTPUT:')[0]) as Record<string, unknown>;
    let out: unknown;
    if (op === 'extract') out = this.extract(input, req);
    else if (op === 'taxonomy') out = this.taxonomy(input, req, null);
    else if (op === 'refine') out = this.taxonomy(input, req, String(input.branch ?? ''));
    else if (op === 'assign') out = this.assign(input, req);
    else if (op === 'link') out = this.link(req);
    else out = { ok: true, role: req.role, echo: 'threadmap-capability-check' };
    const text = JSON.stringify(out);
    return { text, modelId: this.modelIdFor(req.role), fallback: false, usage: { input: Math.ceil(req.user.length / 4), output: Math.ceil(text.length / 4), reasoning: null } };
  }

  private msgFor(native: string | undefined) {
    return native ? this.byNative.get(native) : undefined;
  }

  private extract(input: Record<string, unknown>, req: CompletionRequest) {
    const msgs = (input.messages as { ref: string; reply_to?: string }[]) ?? [];
    const groups = new Map<string, { m: ManifestMessage | undefined; refs: string[] }>();
    for (const pm of msgs) {
      // As instructed, an otherwise unknown reply joins the discussion it quotes.
      const m = this.msgFor(req.fixtureHints?.refs?.[pm.ref]) ?? (pm.reply_to ? this.msgFor(req.fixtureHints?.refs?.[pm.reply_to]) : undefined);
      const key = m?.discussion ?? '__unknown__';
      const g = groups.get(key) ?? { m, refs: [] };
      g.refs.push(pm.ref);
      groups.set(key, g);
    }
    let i = 0;
    return {
      units: [...groups.entries()].map(([key, g]) => {
        if (!g.m) {
          return { unit_key: `x${++i}`, primary_root: 'GENERAL_CHAT', discussion_title: 'Unclassified messages', topic_terms: [], message_refs: g.refs, summary_bullets: [], resource_refs: [], needs_review: true };
        }
        const path = pathOfKey(g.m.topic);
        const title = key.slice(key.indexOf('#') + 1);
        const resourceRefs = g.refs.filter((r) => {
          const m = this.msgFor(req.fixtureHints?.refs?.[r]);
          return m && (m.file || m.urls.length);
        });
        return {
          unit_key: `d${++i}`,
          primary_root: ROOT_OF_LETTER[segs(path)[0]],
          discussion_title: title,
          topic_terms: segs(path).slice(1),
          message_refs: g.refs,
          summary_bullets: [{ text: `${title}: ${g.m.text.slice(0, 120)}`, evidence_refs: [g.refs[0]] }],
          resource_refs: resourceRefs,
          needs_review: false,
        };
      }),
    };
  }

  /** Initial taxonomy (branch=null) or refinement beneath a branch path. */
  private taxonomy(input: Record<string, unknown>, req: CompletionRequest, branch: string | null) {
    const hints = req.fixtureHints ?? {};
    const existingByPath = new Map(Object.entries(hints.topicPaths ?? {}).map(([id, p]) => [p, id]));
    const units = (input.units as { unit_key: string }[]) ?? [];
    let basePath: string | null = null;
    if (branch !== null) {
      const titles = branch.split(' > ');
      basePath = [LETTER_OF_TITLE[titles[0]] ?? titles[0], ...titles.slice(1)].join('/');
    }
    const baseDepth = basePath ? segs(basePath).length : 1;
    const nodes = new Map<string, { key: string; parent: string; title: string; aliases: string[]; may_subdivide: boolean }>();
    const ensure = (fullPath: string): string => {
      // Truncate to at most LEVELS_PER_CALL new levels below the base.
      const parts = segs(fullPath);
      const limit = Math.min(parts.length, baseDepth + LEVELS_PER_CALL);
      const truncated = parts.slice(0, limit).join('/');
      for (let d = baseDepth + 1; d <= limit; d++) {
        const p = parts.slice(0, d).join('/');
        if (existingByPath.has(p) || nodes.has(p)) continue;
        const parentPath = parts.slice(0, d - 1).join('/');
        const parent = d - 1 === 1 ? (existingByPath.get(parentPath) ?? `ROOT:${ROOT_OF_LETTER[parts[0]]}`) : (existingByPath.get(parentPath) ?? parentPath);
        nodes.set(p, { key: p, parent, title: parts[d - 1], aliases: [], may_subdivide: false });
      }
      if (parts.length > limit) {
        const n = nodes.get(truncated);
        if (n) n.may_subdivide = true;
      }
      return existingByPath.get(truncated) ?? (nodes.has(truncated) ? truncated : (existingByPath.get(truncated) ?? `ROOT:${ROOT_OF_LETTER[parts[0]]}`));
    };
    const under = (p: string) => !basePath || p === basePath || p.startsWith(`${basePath}/`);
    const assignments: { unit_key: string; topic: string }[] = [];
    for (const u of units) {
      const natives = hints.units?.[u.unit_key] ?? [];
      const m = this.msgFor(natives[0]);
      if (!m) continue;
      const full = pathOfKey(m.topic);
      if (!under(full)) continue;
      if (basePath && full === basePath) {
        assignments.push({ unit_key: u.unit_key, topic: existingByPath.get(basePath)! });
        continue;
      }
      assignments.push({ unit_key: u.unit_key, topic: ensure(full) });
    }
    const secondary: { message_ref: string; topic: string }[] = [];
    const refList = Object.keys(hints.refs ?? {});
    for (const ref of refList) {
      const m = this.msgFor(hints.refs?.[ref]);
      if (!m) continue;
      for (const a of m.also) {
        const full = pathOfKey(a);
        if (!under(full) || (basePath && full === basePath)) continue;
        secondary.push({ message_ref: ref, topic: ensure(full) });
      }
    }
    return { nodes: [...nodes.values()], assignments, secondary_placements: secondary, no_useful_subdivision: nodes.size === 0 };
  }

  private assign(input: Record<string, unknown>, req: CompletionRequest) {
    const hints = req.fixtureHints ?? {};
    const existingByPath = new Map(Object.entries(hints.topicPaths ?? {}).map(([id, p]) => [p, id]));
    const units = (input.units as { unit_key: string; reply_topics?: string[] }[]) ?? [];
    const assignments = units.map((u) => {
      const m = this.msgFor(hints.units?.[u.unit_key]?.[0]);
      if (!m && u.reply_topics?.length) return { unit_key: u.unit_key, topic_id: u.reply_topics[0], new_topic: null, confidence: 0.75 };
      if (!m) return { unit_key: u.unit_key, topic_id: null, new_topic: null, confidence: 0.1 };
      const full = pathOfKey(m.topic);
      if (existingByPath.has(full)) return { unit_key: u.unit_key, topic_id: existingByPath.get(full)!, new_topic: null, confidence: 0.92 };
      const parts = segs(full);
      for (let d = parts.length - 1; d >= 1; d--) {
        const p = parts.slice(0, d).join('/');
        const id = existingByPath.get(p);
        if (id) return { unit_key: u.unit_key, topic_id: null, new_topic: { parent_id: id, title: parts[d] }, confidence: 0.8 };
      }
      return { unit_key: u.unit_key, topic_id: null, new_topic: null, confidence: 0.1 };
    });
    const secondary: { message_ref: string; topic_id: string }[] = [];
    for (const [ref, native] of Object.entries(hints.refs ?? {})) {
      const m = this.msgFor(native);
      for (const a of m?.also ?? []) {
        const id = existingByPath.get(pathOfKey(a));
        if (id) secondary.push({ message_ref: ref, topic_id: id });
      }
    }
    return { assignments, secondary_placements: secondary };
  }

  private link(req: CompletionRequest) {
    const hints = req.fixtureHints ?? {};
    const a = hints.topicPaths?.a ?? '';
    const b = hints.topicPaths?.b ?? '';
    const refs = Object.entries(hints.refs ?? {});
    const aRefs = refs.filter(([r]) => r.startsWith('a'));
    const bRefs = refs.filter(([r]) => r.startsWith('b'));
    const urlsOf = (n: string) => this.msgFor(n)?.urls ?? [];
    for (const [ra, na] of aRefs) {
      for (const [rb, nb] of bRefs) {
        if (urlsOf(na).some((u) => urlsOf(nb).includes(u))) {
          return { related: true, relation_type: 'SHARED_RESOURCE', reason: 'Both chats share the same resource link.', a_evidence_refs: [ra], b_evidence_refs: [rb] };
        }
      }
    }
    const last = (p: string) => segs(p).at(-1)?.toLowerCase();
    if (a && last(a) === last(b) && aRefs.length && bRefs.length) {
      return { related: true, relation_type: 'RELATED_TOPIC', reason: `Both chats discuss ${segs(a).at(-1)}.`, a_evidence_refs: [aRefs[0][0]], b_evidence_refs: [bRefs[0][0]] };
    }
    return { related: false, relation_type: null, reason: 'Only superficial word overlap.', a_evidence_refs: [], b_evidence_refs: [] };
  }
}
