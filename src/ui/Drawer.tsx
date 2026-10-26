'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, filterParams, qs, type FilterState } from './client';
import type { ContentFile, ContentMessage, ContentResponse, PathItem, SourceMessage } from './types';

const pathText = (p: PathItem[]) => p.map((x) => x.title).join(' › ');
const time = (s: string | null, tz: string) => (s ? new Date(s).toLocaleString('en-SG', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown time');

interface RelatedItem {
  link_id: string;
  relation_type: string;
  reason: string;
  a: { chat_id: string; chat_title: string; topic_id: string; path: PathItem[]; evidence: { message_id: string; sender: string; snippet: string }[] };
  b: { chat_id: string; chat_title: string; topic_id: string; path: PathItem[]; evidence: { message_id: string; sender: string; snippet: string }[] };
}

/** Exact source with revision-aware two-second foreground dwell. */
export function SourceView({ messageId, tz, dwellMs, autoRead, suppressed, onSuppress, onChanged, onOpenMessage }: { messageId: string; tz: string; dwellMs: number; autoRead: boolean; suppressed: boolean; onSuppress: (id: string) => void; onChanged: () => void; onOpenMessage: (chatId: string, id: string) => void }) {
  const [m, setM] = useState<SourceMessage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fileState, setFileState] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    api<SourceMessage>(`/api/messages/${messageId}`).then(setM, (e: Error) => setErr(e.message));
  }, [messageId]);
  useEffect(load, [load]);

  // Dwell timer: pauses/resets when hidden, unfocused, closed, or revision changes.
  useEffect(() => {
    if (!m || !m.reviewable || m.review === 'read' || !autoRead || suppressed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        timer = setTimeout(async () => {
          await api('/api/review', { method: 'POST', json: { message_id: m.message_id, status: 'read', revision: m.content_revision, source: 'dwell' } }).catch(() => undefined);
          load();
          onChanged();
        }, dwellMs);
      }
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    window.addEventListener('focus', arm);
    window.addEventListener('blur', arm);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
      window.removeEventListener('focus', arm);
      window.removeEventListener('blur', arm);
    };
  }, [m, autoRead, suppressed, dwellMs, load, onChanged]);

  if (err) return <p role="alert">{err}</p>;
  if (!m) return <p>Loading source…</p>;
  const mark = async (status: 'read' | 'missed') => {
    if (status === 'missed') onSuppress(m.message_id);
    await api('/api/review', { method: 'POST', json: { message_id: m.message_id, status, revision: m.content_revision, source: 'manual' } });
    load();
    onChanged();
  };
  const fetchFile = async (id: string) => {
    setFileState((s) => ({ ...s, [id]: 'fetching' }));
    const r = await api<{ availability: string; reason?: string }>(`/api/attachments/${id}/fetch`, { method: 'POST' }).catch((e: Error) => ({ availability: 'failed', reason: e.message }));
    setFileState((s) => ({ ...s, [id]: r.reason ? `${r.availability}: ${r.reason}` : r.availability }));
    load();
  };
  return (
    <article aria-label="Selected source message">
      <div className="path">{m.chat.title}</div>
      {m.topic_paths.map((p, i) => (
        <div key={i} className="path">
          {p.primary ? '● ' : '○ '}
          {pathText(p.path)}
        </div>
      ))}
      <p>
        <strong>{m.sender}</strong> · {m.direction === 'outgoing' ? 'sent by you' : 'received'} · {time(m.sent_at, tz)} <span className="counts">({tz})</span>
        {m.edited_at ? <span className="pill" style={{ marginLeft: 6 }}>edited · revision {m.content_revision}</span> : null}
      </p>
      {m.marker ? <p className="pill">{m.marker}</p> : <div className="src">{m.body}</div>}
      {m.attachments.map((a) => (
        <div key={a.id} className="msg">
          📎 {a.filename ?? a.media_type} <span className="counts">{a.mime ?? ''} {a.size ? `· ${(a.size / 1024).toFixed(1)} KiB` : ''} · {fileState[a.id] ?? a.availability}</span>
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            {a.availability === 'cached' ? (
              <>
                <a href={`/api/attachments/${a.id}/content`} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
                <a href={`/api/attachments/${a.id}/content?download=1`}>Download</a>
              </>
            ) : a.availability === 'available' || a.availability === 'failed' ? (
              <button onClick={() => fetchFile(a.id)}>Fetch file</button>
            ) : (
              <span className="counts">{a.availability === 'fetching' ? 'Fetching…' : 'Not retrievable'}</span>
            )}
          </div>
        </div>
      ))}
      {m.reviewable ? (
        <p>
          Status: <strong className={m.review === 'missed' ? 'missed' : 'readbadge'}>{m.review === 'missed' ? 'Missed' : 'Read'}</strong>{' '}
          <button onClick={() => mark('read')}>Mark Read</button> <button onClick={() => mark('missed')}>Mark Missed</button>
          {m.review === 'missed' && autoRead && !suppressed ? <span className="counts"> · marks Read after 2 s in view</span> : null}
        </p>
      ) : null}
      {m.context.length ? (
        <section aria-label="Neighbouring context">
          <h4 style={{ marginBottom: 4 }}>Context outside current filter</h4>
          {m.context.map((c) => (
            <button key={c.message_id} className="ctx" style={{ display: 'block', textAlign: 'left', border: 'none', background: 'none', width: '100%' }} onClick={() => onOpenMessage(m.chat.id, c.message_id)}>
              <strong>{c.sender}</strong> {time(c.sent_at, tz)}: {c.snippet ?? '(removed)'}
            </button>
          ))}
        </section>
      ) : null}
      <p className="counts">
        Permalink: <code>/chats/{m.chat.id}/messages/{m.message_id}</code>
      </p>
    </article>
  );
}

export function NodeDrawer({ chatId, nodeId, filter, onOpenMessage, onChanged, onFilterTopic, onRevealPath, refreshKey }: { chatId: string; nodeId: string; filter: FilterState; onOpenMessage: (chatId: string, id: string) => void; onChanged: () => void; onFilterTopic: (id: string) => void; onRevealPath: (chatId: string, topicId: string) => void; refreshKey: number }) {
  const [tab, setTab] = useState<'messages' | 'files' | 'related'>('messages');
  const [data, setData] = useState<ContentResponse | null>(null);
  const [items, setItems] = useState<(ContentMessage | ContentFile)[]>([]);
  const [fullSummary, setFullSummary] = useState(false);
  const [related, setRelated] = useState<RelatedItem[] | null>(null);
  const [bulk, setBulk] = useState<{ id: string; count: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const gen = useRef(0);
  const fp = JSON.stringify(filterParams(filter));

  const load = useCallback(
    async function loadPage(cursor?: string): Promise<void> {
      if (tab === 'related') {
        const r = await api<{ related: RelatedItem[] }>(`/api/related?${qs({ topic: nodeId })}`).catch(() => ({ related: [] }));
        setRelated(r.related);
        return;
      }
      const my = ++gen.current;
      const r = await api<ContentResponse>(`/api/chats/${chatId}/nodes/${nodeId}/content?${qs({ ...filterParams(filter), tab, cursor, full_summary: fullSummary ? '1' : undefined })}`).catch((e: Error & { status?: number }) => {
        if (e.status === 409 && cursor) return null; // stale cursor → refetch from first page
        throw e;
      });
      if (my !== gen.current) return; // discard superseded responses
      if (!r) return loadPage();
      setData(r);
      setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, nodeId, tab, fp, fullSummary],
  );
  useEffect(() => {
    setItems([]);
    void load();
  }, [load, refreshKey]);
  useEffect(() => setBulk(null), [nodeId, fp]);

  const preview = async () => {
    const r = await api<{ snapshotId: string; count: number }>(`/api/chats/${chatId}/bulk-preview`, { method: 'POST', json: { node_id: nodeId, filter: filterParams(filter) } });
    setBulk({ id: r.snapshotId, count: r.count });
  };
  const execute = async (target: 'read' | 'missed') => {
    if (!bulk) return;
    const r = await api<{ updated: number; changedRevision: number; unavailable: number }>('/api/review/bulk', { method: 'POST', json: { snapshot_id: bulk.id, target } });
    setNote(`Updated ${r.updated}. ${r.changedRevision ? `${r.changedRevision} changed since selection and stayed Missed.` : ''}`);
    setBulk(null);
    onChanged();
    void load();
  };

  return (
    <div>
      <div className="dhead">
        <div className="path">{data ? pathText(data.node_path) : '…'}</div>
        <div>
          <strong>{data?.matching_message_count.toLocaleString('en-US') ?? '…'}</strong> matching messages
          {data?.matching_missed_count ? <span className="missed"> · {data.matching_missed_count} missed</span> : null}
          {data ? <span className="counts"> · {data.matching_file_count} files · includes all deeper topics</span> : null}
        </div>
        <div className="tabs" role="tablist">
          {(['messages', 'files', 'related'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'messages' ? 'Messages' : t === 'files' ? 'Files' : 'Related chats'}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => onFilterTopic(nodeId)}>Filter to this topic</button>
          {bulk ? (
            <>
              <span className="pill">{bulk.count} messages in scope</span>
              <button onClick={() => execute('read')}>Mark these {bulk.count} Read</button>
              <button onClick={() => execute('missed')}>Mark Missed</button>
              <button onClick={() => setBulk(null)}>Cancel</button>
            </>
          ) : (
            <button onClick={preview}>Bulk review…</button>
          )}
        </div>
        {note ? <div className="counts" role="status">{note}</div> : null}
      </div>
      <div className="dbody">
        {data?.summary.available && tab === 'messages' ? (
          <section aria-label="Grounded summary">
            {data.summary.coverage === 'hidden_for_filtered_view' ? (
              <p className="counts">
                {data.summary.note} <button onClick={() => setFullSummary(true)}>View full-topic summary</button>
              </p>
            ) : (
              <ul>
                {data.summary.claims.map((c) => (
                  <li key={c.id}>
                    {c.text}{' '}
                    {c.evidence.map((e, i) => (
                      <button key={e.m} style={{ fontSize: 11, padding: '0 4px' }} onClick={() => onOpenMessage(chatId, e.m)} aria-label="Open cited source">
                        [{i + 1}]
                      </button>
                    ))}
                  </li>
                ))}
                {fullSummary ? <li className="counts">Full-topic summary (all dates and review states)</li> : null}
              </ul>
            )}
          </section>
        ) : null}
        {tab === 'related' ? (
          related === null ? (
            <p>Loading…</p>
          ) : related.length === 0 ? (
            <p className="counts">No verified related topics in other chats.</p>
          ) : (
            related.map((l) => {
              const other = l.a.topic_id === nodeId ? l.b : l.a;
              const self = l.a.topic_id === nodeId ? l.a : l.b;
              return (
                <div key={l.link_id} className="msg">
                  <div className="pill">{l.relation_type === 'SHARED_RESOURCE' ? 'Shared resource' : 'Related topic'}</div> {l.reason}
                  <p className="path">
                    {other.chat_title}: {pathText(other.path)}
                  </p>
                  <div className="counts">Evidence here:</div>
                  {self.evidence.map((e) => (
                    <button key={e.message_id} className="ctx" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none' }} onClick={() => onOpenMessage(self.chat_id, e.message_id)}>
                      {e.sender}: {e.snippet}
                    </button>
                  ))}
                  <div className="counts">Evidence in {other.chat_title}:</div>
                  {other.evidence.map((e) => (
                    <button key={e.message_id} className="ctx" style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none' }} onClick={() => onOpenMessage(other.chat_id, e.message_id)}>
                      {e.sender}: {e.snippet}
                    </button>
                  ))}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => onRevealPath(other.chat_id, other.topic_id)}>Open topic in {other.chat_title}</button>
                    <button
                      onClick={async () => {
                        await api(`/api/related/${l.link_id}/dismiss`, { method: 'POST' });
                        void load();
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })
          )
        ) : items.length === 0 && data ? (
          <p className="counts">{filter.status === 'missed' ? 'All caught up here. Switch to All to view every message.' : 'No matching content.'}</p>
        ) : (
          items.map((it) =>
            'attachment_id' in it ? (
              <div key={it.attachment_id} className="msg">
                📎 <strong>{it.filename ?? it.media_type}</strong> <span className="counts">{it.availability}</span>
                <div className="path">{it.topic_paths.map(pathText).join(' | ')}</div>
                <button onClick={() => onOpenMessage(chatId, it.message_id)}>Open source message</button>{' '}
                {it.availability === 'cached' ? (
                  <a href={`/api/attachments/${it.attachment_id}/content`} target="_blank" rel="noopener noreferrer">
                    Open file
                  </a>
                ) : null}
              </div>
            ) : (
              <button key={it.message_id} className="msg" onClick={() => onOpenMessage(chatId, it.message_id)}>
                <div>
                  <strong>{it.sender}</strong> <span className="counts">{it.sent_at ? new Date(it.sent_at).toLocaleString('en-SG', { timeZone: filter.tz }) : 'Unknown time'}</span>{' '}
                  <span className={it.review === 'missed' ? 'missed' : 'readbadge'}>{it.review === 'missed' ? '● Missed' : '✓ Read'}</span>
                  {it.edited ? <span className="pill">edited</span> : null}
                  {it.attachment_count ? <span className="pill">📎 {it.attachment_count}</span> : null}
                </div>
                <div>{it.snippet ?? '(no text)'}</div>
                <div className="path">{it.topic_paths.map(pathText).join(' | ')}</div>
              </button>
            ),
          )
        )}
        {data?.next_cursor && tab !== 'related' ? <button onClick={() => load(data.next_cursor!)}>Load more</button> : null}
      </div>
    </div>
  );
}
