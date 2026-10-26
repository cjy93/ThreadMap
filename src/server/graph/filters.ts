// One server-side content-filter contract shared by map counts, node content,
// search, resources, bulk review and related views. Show depth is NOT part of
// it: display projection never changes matching membership.
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { isUuid, SafeError, sha256, stableJson } from '../util';

export const StatusFilter = z.enum(['all', 'missed', 'read']);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ContentFilterSchema = z.object({
  status: StatusFilter.default('missed'),
  from: day.optional(),
  to: day.optional(),
  tz: z.string().default('Asia/Singapore'),
  includeUndated: z.boolean().default(false),
  topicIds: z.array(z.string().refine(isUuid)).max(50).default([]),
});
export type ContentFilter = z.infer<typeof ContentFilterSchema>;

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse filters from URL search params (shared by every surface). */
export function parseContentFilter(params: URLSearchParams, defaults: { tz: string }): ContentFilter {
  const raw = {
    status: params.get('status') ?? undefined,
    from: params.get('from') || undefined,
    to: params.get('to') || undefined,
    tz: params.get('tz') || defaults.tz,
    includeUndated: params.get('undated') === '1' || params.get('undated') === 'true',
    topicIds: (params.get('topics') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  };
  const r = ContentFilterSchema.safeParse(raw);
  if (!r.success) throw new SafeError('invalid filter parameters');
  if (!validTimezone(r.data.tz)) throw new SafeError('invalid timezone');
  if (r.data.from && r.data.to && r.data.from > r.data.to) throw new SafeError('date range start is after end');
  return { ...r.data, topicIds: [...new Set(r.data.topicIds)].sort() };
}

export type DisplayDepth = number | 'all';

export function parseDisplayDepth(v: string | null | undefined): DisplayDepth | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (v === 'all') return 'all';
  if (!/^\d+$/.test(v)) throw new SafeError('max_topic_depth must be a nonnegative integer or "all"');
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new SafeError('max_topic_depth must be a safe integer');
  return n;
}

/**
 * Fingerprint identifying the effective content filter in a user/workspace
 * scope. Count caches and responses are keyed by it; it deliberately excludes
 * display depth, expansion and pagination.
 */
export function filterFingerprint(scope: { userId: string; workspaceId: string; chatIds: string[] }, f: ContentFilter): string {
  return sha256(stableJson({ u: scope.userId, w: scope.workspaceId, c: [...scope.chatIds].sort(), f })).slice(0, 32);
}

/** SQL predicate: canonical eligible human message (not system/unsupported/tombstone/expired). */
export const eligibleSql = (alias = 'm'): SQL =>
  sql.raw(`${alias}.kind IN ('text','media') AND ${alias}.state = 'active' AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > now())`);

/** SQL expression: effective Read for the current content revision. */
export const isReadSql = (m = 'm', rs = 'rs'): SQL =>
  sql.raw(`(${rs}.status = 'read' AND ${rs}.reviewed_revision = ${m}.content_revision)`);

/**
 * A SELECT returning (id, content_revision, is_read) for every canonical message
 * in `chatIds` within `workspaceId` that matches the content filter. Topic
 * filters include each selected topic's entire recursive subtree (union).
 */
export function matchingMessagesSql(scope: { userId: string; workspaceId: string; chatIds: string[] }, f: ContentFilter): SQL {
  const chatList = sql.join(scope.chatIds.map((c) => sql`${c}::uuid`), sql`, `);
  const parts: SQL[] = [sql`m.workspace_id = ${scope.workspaceId}::uuid`, sql`m.chat_id IN (${chatList})`, eligibleSql('m')];
  if (f.from || f.to) {
    const range: SQL[] = [];
    if (f.from) range.push(sql`m.sent_at >= ((${f.from})::date::timestamp AT TIME ZONE ${f.tz})`);
    if (f.to) range.push(sql`m.sent_at < (((${f.to})::date + 1)::timestamp AT TIME ZONE ${f.tz})`);
    const dated = sql.join(range, sql` AND `);
    parts.push(f.includeUndated ? sql`((${dated}) OR m.sent_at IS NULL)` : sql`(m.sent_at IS NOT NULL AND ${dated})`);
  }
  if (f.status === 'missed') parts.push(sql`NOT COALESCE(${isReadSql()}, false)`);
  if (f.status === 'read') parts.push(sql`COALESCE(${isReadSql()}, false)`);
  if (f.topicIds.length) {
    const ids = sql.join(f.topicIds.map((t) => sql`${t}::uuid`), sql`, `);
    parts.push(sql`m.id IN (
      WITH RECURSIVE sel(id) AS (
        SELECT COALESCE(mm.surviving_id, t0.id) FROM topics t0
          LEFT JOIN topic_merge_map mm ON mm.retired_id = t0.id
          WHERE t0.id IN (${ids}) AND t0.workspace_id = ${scope.workspaceId}::uuid
        UNION
        SELECT t.id FROM topics t JOIN sel ON t.parent_id = sel.id WHERE t.retired_into IS NULL
      )
      SELECT p.message_id FROM placements p JOIN sel ON sel.id = p.topic_id)`);
  }
  return sql`SELECT m.id, m.content_revision, COALESCE(${isReadSql()}, false) AS is_read
    FROM messages m
    LEFT JOIN review_state rs ON rs.user_id = ${scope.userId} AND rs.message_id = m.id
    WHERE ${sql.join(parts, sql` AND `)}`;
}

export function filterToSearchParams(f: Partial<ContentFilter>): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status) p.set('status', f.status);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.tz) p.set('tz', f.tz);
  if (f.includeUndated) p.set('undated', '1');
  if (f.topicIds?.length) p.set('topics', f.topicIds.join(','));
  return p;
}
