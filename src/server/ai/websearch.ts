// Web search for concept maps (Tavily). Runs in the worker only, which holds the
// key. Queries leave ThreadMap, so they are cleaned of anything personal first;
// results are untrusted page text, handed to the model as data.

export interface WebResult {
  title: string;
  url: string;
  content: string;
}

export type WebSearch = (query: string) => Promise<WebResult[]>;

const TAVILY_URL = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 20_000;
const RESULTS_PER_QUERY = 4;
const CONTENT_CHARS = 700;

/**
 * A query safe to send out: no email addresses, phone numbers, @handles, links
 * or the names of people in the chat. Returns '' when too little is left.
 */
export function cleanQuery(query: string, names: string[] = []): string {
  let q = query
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:\+|\b)\d[\d\s().-]{6,}\d\b/g, ' ')
    .replace(/@\w+/g, ' ');
  for (const n of names) {
    for (const part of n.split(/\s+/).filter((p) => p.length >= 3)) {
      q = q.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
    }
  }
  q = q.replace(/\s+/g, ' ').trim().slice(0, 200);
  return q.replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? q : '';
}

export function tavilySearch(apiKey: string): WebSearch {
  return async (query) => {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: RESULTS_PER_QUERY, topic: 'general', include_answer: false }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    // The status alone: the body could echo the query.
    if (!res.ok) throw new Error(`web search failed (${res.status})`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? [])
      .filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
      .map((r) => ({ title: (r.title ?? r.url!).slice(0, 200), url: r.url!.slice(0, 500), content: (r.content ?? '').slice(0, CONTENT_CHARS) }));
  };
}
