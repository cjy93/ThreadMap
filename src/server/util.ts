import crypto from 'node:crypto';

export const sha256 = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');

/** Stable JSON (sorted keys) for fingerprints. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

/** Case-insensitive, Unicode-normalized form used for substring search. */
export function normalizeSearch(s: string): string {
  return s.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/g, ' ').trim();
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/giu;

export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[),.;:!?\]}>]+$/u, '');
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Canonical URL for cross-chat SHARED_RESOURCE matching (no fragment, no tracking params). */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Errors whose message is safe to show users / write to logs. */
export class SafeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'bad_request',
  ) {
    super(message);
  }
}
