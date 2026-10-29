'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, filterParams, openOnDoubleClick, qs, sourceNumbers, type FilterState } from './client';
import type { ChainMessage, ContentFile, ContentMessage, ContentResponse, PathItem, SourceMessage } from './types';

const pathText = (p: PathItem[]) => p.map((x) => x.title).join(' › ');
const time = (s: string | null, tz: string) => (s ? new Date(s).toLocaleString('en-SG', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown time');

interface MediaItem {
  id: string;
  media_type: string;
  availability: string;
  has_preview: boolean;
  description: string | null;
}

/**
 * Shows an attachment the way WhatsApp would: images inline, videos and voice
 * clips as players (loaded on request), with the vision model's reading below.
 */
function MediaView({ a, onFetch }: { a: MediaItem; onFetch: (id: string) => void }) {
  const src = `/api/attachments/${a.id}/content`;
  const preview = a.has_preview ? `/api/attachments/${a.id}/preview` : undefined;
  const cached = a.availability === 'cached';
  const loadable = a.availability === 'available' || a.availability === 'failed';
  const load = (label: string) => (loadable ? <button onClick={() => onFetch(a.id)}>{label}</button> : a.availability === 'fetching' ? <span className="counts">Loading…</span> : null);
  let view: React.ReactNode = null;
  if (a.media_type === 'image' || a.media_type === 'sticker') {
    const cls = a.media_type === 'sticker' ? 'media sticker' : 'media';
    // eslint-disable-next-line @next/next/no-img-element
    view = cached ? <img className={cls} src={src} alt={a.description ?? (a.media_type === 'sticker' ? 'Sticker' : 'Shared image')} loading="lazy" /> : preview ? <img className={`${cls} preview`} src={preview} alt="Image preview" /> : null;
    if (!cached) view = <>{view}{load(a.media_type === 'sticker' ? 'Load sticker' : 'Load full image')}</>;
  } else if (a.media_type === 'video') {
    view = cached ? <video className="media" src={src} poster={preview} controls preload="metadata" /> : (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview ? <img className="media preview" src={preview} alt="Video preview" /> : null}
        {load('▶ Load video')}
      </>
    );
  } else if (a.media_type === 'audio') {
    view = cached ? <audio src={src} controls preload="none" /> : load('▶ Load voice clip');
  }
  if (!view) return null;
  return (
    <div className="media-wrap">
      {view}
      {a.description ? <div className="counts">Nemotron VL: {a.description}</div> : null}
    </div>
  );
}

// Messages per page of the Chatroom (as the server sends them).
const CHATROOM_PAGE = 15;

/**
 * Chatroom: the chat in time order around the opened message, as in WhatsApp.
 * Scrolling to the top or bottom loads the next page of earlier or later messages.
 */
function Chatroom({ first, tz, onOpen }: { first: SourceMessage['context']; tz: string; onOpen: (id: string) => void }) {
  const [items, setItems] = useState(first);
  const at = first.findIndex((c) => c.current);
  const [more, setMore] = useState({ before: at >= CHATROOM_PAGE, after: first.length - 1 - at >= CHATROOM_PAGE });
  const box = useRef<HTMLElement>(null);
  const busy = useRef(false);
  useEffect(() => {
    const el = box.current;
    const cur = el?.querySelector<HTMLElement>('[aria-current="true"]');
    if (el && cur) el.scrollTop = cur.offsetTop - el.offsetTop - 80;
  }, []);
  const load = async (dir: 'before' | 'after') => {
    if (busy.current || !more[dir] || !items.length) return;
    busy.current = true;
    const edge = dir === 'before' ? items[0] : items[items.length - 1];
    const r = await api<{ messages: SourceMessage['context']; more: boolean }>(`/api/messages/${edge.message_id}/chatroom?dir=${dir}`).catch(() => null);
    const el = box.current;
    const height = el?.scrollHeight ?? 0;
    if (r) {
      setItems((cur) => (dir === 'before' ? [...r.messages, ...cur] : [...cur, ...r.messages]));
      setMore((m) => ({ ...m, [dir]: r.more }));
      // Keep the view still while earlier messages are added above it.
      if (dir === 'before' && el) requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - height));
    }
    busy.current = false;
  };
  return (
    <section
      aria-label="Chatroom"
      className="thread thread-catalog"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop < 60) void load('before');
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) void load('after');
      }}
    >
      {more.before ? (
        <button className="thread-label" onClick={() => void load('before')}>
          ↑ Earlier messages
        </button>
      ) : (
        <div className="thread-label">Start of the saved chat</div>
      )}
      {items.map((c) =>
        c.current ? (
          <div key={c.message_id} className={`tmsg current ${c.direction === 'outgoing' ? 'mine' : ''}`} aria-current="true">
            <div className="meta">
              <strong>{c.sender}</strong> · {time(c.sent_at, tz)} · this message
            </div>
            {c.snippet ?? '(removed)'}
          </div>
        ) : (
          <div key={c.message_id} className={`tmsg ${c.direction === 'outgoing' ? 'mine' : ''}`} {...openOnDoubleClick(() => onOpen(c.message_id))}>
            <div className="meta">
              <strong>{c.sender}</strong> · {time(c.sent_at, tz)}
            </div>
            {c.snippet ?? '(removed)'}
          </div>
        ),
      )}
      {more.after ? (
        <button className="thread-label" onClick={() => void load('after')}>
          ↓ Later messages
        </button>
      ) : (
        <div className="thread-label">Latest saved message</div>
      )}
    </section>
  );
}

/** One message of a reply chain, indented by how many reply steps it is from the opened message. */
function ChainItem({ c, tz, onOpen }: { c: ChainMessage; tz: string; onOpen: () => void }) {
  return (
    <div className={`tmsg ${c.direction === 'outgoing' ? 'mine' : ''}`} style={{ marginLeft: Math.min(c.depth - 1, 4) * 14 }} {...openOnDoubleClick(onOpen)}>
      <div className="meta">
        <strong>{c.sender}</strong> · {time(c.sent_at, tz)} · {c.depth === 1 ? 'direct' : `${c.depth} replies away`}
        {c.inferred ? <span title="Reply was not used; Nemotron read this as an answer"> · inferred</span> : null}
      </div>
      {c.snippet ?? '(removed)'}
    </div>
  );
}

/** Exact source with revision-aware two-second foreground dwell. */
export function SourceView({
  messageId,
  tz,
  dwellMs,
  suppressed,
  onSuppress,
  onChanged,
  onOpenMessage,
  onConceptMap,
}: {
  messageId: string;
  tz: string;
  dwellMs: number;
  suppressed: boolean;
  onSuppress: (id: string) => void;
  onChanged: () => void;
  onOpenMessage: (chatId: string, id: string) => void;
  /** Open this message's concept map (offered for Knowledge and Resources messages). */
  onConceptMap?: (id: string) => void;
}) {
  const [m, setM] = useState<SourceMessage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fileState, setFileState] = useState<Record<string, string>>({});
  // Below the message: its reply chain (what it replies to and the replies to it), or the chat in time order.
  const [around, setAround] = useState<'chain' | 'chatroom'>('chain');
  const load = useCallback(() => {
    api<SourceMessage>(`/api/messages/${messageId}`).then(setM, (e: Error) => setErr(e.message));
  }, [messageId]);
  useEffect(load, [load]);
  // Answers given without WhatsApp's Reply: Nemotron reads an opened discussion for them once.
  const [answersNote, setAnswersNote] = useState<string | null>(null);
  const needsAnswers = Boolean(m?.thread && !m.thread.answers_checked);
  useEffect(() => {
    if (!needsAnswers) return;
    let live = true;
    api<{ checked: boolean; note?: string }>(`/api/messages/${messageId}/answers`, { method: 'POST' }).then(
      (r) => {
        if (!live) return;
        setAnswersNote(r.checked ? null : (r.note ?? null));
        if (r.checked) load();
      },
      (e: Error) => live && setAnswersNote(e.message),
    );
    return () => {
      live = false;
    };
  }, [needsAnswers, messageId, load]);

  // Dwell timer: pauses/resets when hidden, unfocused, closed, or revision changes.
  useEffect(() => {
    if (!m || !m.reviewable || m.review === 'read' || suppressed) return;
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
  }, [m, suppressed, dwellMs, load, onChanged]);

  if (err) return <p role="alert">{err}</p>;
  if (!m) return <p>Loading source…</p>;
  const chainCount = m.reply_chain.before.length + m.reply_chain.after.length;
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
      {m.marker ? <p className="pill">{m.marker}</p> : m.body ? <div className="src">{m.body}</div> : null}
      {onConceptMap && m.state === 'active' && m.topic_paths.some((p) => p.root === 'KNOWLEDGE' || p.root === 'RESOURCES') ? (
        <p>
          <button
            className="primary"
            onClick={() => onConceptMap(m.message_id)}
            title="NVIDIA Nemotron Ultra reads this message's discussion, the questions and answers around it and its whole topic branch up to the root, searches the web for documentation, and builds a concept map with a study guide"
          >
            🧭 Concept map
          </button>
        </p>
      ) : null}
      {m.attachments.map((a) => (
        <div key={a.id} className="msg">
          <MediaView a={a} onFetch={fetchFile} />
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
          {m.review === 'missed' && !suppressed ? <span className="counts"> · marks Read after 2 s in view</span> : null}
        </p>
      ) : null}
      {/* What surrounds this message: its reply chain, or the chat in time order. */}
      <div className="seg" role="group" aria-label="Show around this message" style={{ marginTop: 8 }}>
        <button
          aria-pressed={around === 'chain'}
          onClick={() => setAround('chain')}
          title="What this message replies to and every reply to it (and replies to those): WhatsApp replies, and answers given without pressing Reply that Nemotron found"
        >
          Discussion{chainCount ? ` (${chainCount})` : ''}
        </button>
        <button aria-pressed={around === 'chatroom'} onClick={() => setAround('chatroom')} title="The chat in time order, as in WhatsApp: scroll up or down for more">
          Chatroom
        </button>
      </div>
      {around === 'chain' ? (
        <section aria-label="Discussion: reply chain" className="thread thread-catalog">
          {/* The subject Nemotron filed this message under, and how many messages it grouped there. */}
          {m.thread ? (
            <h4 className="discussion-title">
              Discussion: {m.thread.title} <span className="counts">· {m.thread.messages.length} messages</span>
            </h4>
          ) : null}
          {needsAnswers ? <p className="counts">{answersNote ?? 'NVIDIA Nemotron is finding which messages answer which (when Reply was not used)…'}</p> : null}
          {m.reply_chain.before.length ? <div className="thread-label">Replied to, earliest first</div> : null}
          {m.reply_chain.before.map((c) => (
            <ChainItem key={c.message_id} c={c} tz={tz} onOpen={() => onOpenMessage(m.chat.id, c.message_id)} />
          ))}
          <div className={`tmsg current ${m.direction === 'outgoing' ? 'mine' : ''}`} aria-current="true">
            <div className="meta">
              <strong>{m.sender}</strong> · {time(m.sent_at, tz)} · this message
            </div>
            {m.body ?? m.marker ?? '(no text)'}
          </div>
          {m.reply_chain.after.length ? <div className="thread-label">Replies, in time order</div> : null}
          {m.reply_chain.after.map((c) => (
            <ChainItem key={c.message_id} c={c} tz={tz} onOpen={() => onOpenMessage(m.chat.id, c.message_id)} />
          ))}
          {!chainCount && !needsAnswers ? <p className="counts">No replies to or from this message, including answers given without Reply. See it in the Chatroom.</p> : null}
        </section>
      ) : (
        <Chatroom key={m.message_id} first={m.context} tz={tz} onOpen={(id) => onOpenMessage(m.chat.id, id)} />
      )}
      <p className="counts">
        Permalink: <code>/chats/{m.chat.id}/messages/{m.message_id}</code>
      </p>
    </article>
  );
}

export function NodeDrawer({ chatId, nodeId, filter, onOpenMessage, onChanged, refreshKey }: { chatId: string; nodeId: string; filter: FilterState; onOpenMessage: (chatId: string, id: string) => void; onChanged: () => void; refreshKey: number }) {
  const [tab, setTab] = useState<'messages' | 'files'>('messages');
  const [data, setData] = useState<ContentResponse | null>(null);
  const [items, setItems] = useState<(ContentMessage | ContentFile)[]>([]);
  const [fullSummary, setFullSummary] = useState(false);
  const [bulk, setBulk] = useState<{ id: string; count: number; filler: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const gen = useRef(0);
  const fp = JSON.stringify(filterParams(filter));

  const load = useCallback(
    async function loadPage(cursor?: string): Promise<void> {
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

  const markRead = async (it: ContentMessage) => {
    setItems((cur) => cur.map((x) => ('message_id' in x && x.message_id === it.message_id && !('attachment_id' in x) ? { ...x, review: 'read' as const } : x)));
    try {
      await api('/api/review', { method: 'POST', json: { message_id: it.message_id, status: 'read', revision: it.content_revision, source: 'manual' } });
    } catch (e) {
      setNote((e as Error).message);
      void load();
    }
    onChanged();
  };
  const fetchFile = async (id: string) => {
    await api(`/api/attachments/${id}/fetch`, { method: 'POST' }).catch(() => undefined);
    void load();
  };
  const preview = async () => {
    const r = await api<{ snapshotId: string; count: number; filler?: number }>(`/api/chats/${chatId}/bulk-preview`, { method: 'POST', json: { node_id: nodeId, filter: filterParams(filter) } });
    setBulk({ id: r.snapshotId, count: r.count, filler: r.filler ?? 0 });
  };
  const execute = async (target: 'read' | 'missed') => {
    if (!bulk) return;
    const r = await api<{ updated: number; changedRevision: number; unavailable: number }>('/api/review/bulk', { method: 'POST', json: { snapshot_id: bulk.id, target } });
    setNote(`Updated ${r.updated}. ${r.changedRevision ? `${r.changedRevision} changed since selection and stayed Missed.` : ''}`);
    setBulk(null);
    onChanged();
    void load();
  };
  const srcNo = sourceNumbers(data?.summary?.claims.flatMap((c) => c.evidence.map((e) => e.m)) ?? []);

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
          {(['messages', 'files'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'messages' ? 'Messages' : 'Files'}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {bulk ? null : <button onClick={preview}>Bulk review…</button>}
        </div>
        {/* Bulk review's own choices, set apart from the tabs above so they read as one step. */}
        {bulk ? (
          <div className="bulk-panel" role="group" aria-label="Bulk review">
            <div className="bulk-title">Bulk review · this topic and everything beneath it</div>
            <div className="counts">
              {bulk.count.toLocaleString('en-US')} messages
              {bulk.filler ? ` — the ones listed here plus ${bulk.filler.toLocaleString('en-US')} small-talk messages left off the map, so nothing stays Missed` : ''}
            </div>
            <div className="bulk-actions">
              <button className="primary" onClick={() => execute('read')}>
                Mark all {bulk.count.toLocaleString('en-US')} Read
              </button>
              <button onClick={() => execute('missed')}>Mark all Missed</button>
              <button onClick={() => setBulk(null)}>Cancel</button>
            </div>
          </div>
        ) : null}
        {note ? <div className="counts" role="status">{note}</div> : null}
      </div>
      <div className="dbody">
        {data?.summary.available && tab === 'messages' ? (
          // A closed drop-down: the messages start right below it, and once open its points scroll inside it.
          <details className="summary-drop" aria-label="Grounded summary">
            <summary>
              Summary by Nemotron{data.summary.claims.length ? ` · ${data.summary.claims.length} point${data.summary.claims.length === 1 ? '' : 's'}` : ''}
            </summary>
            {data.summary.coverage === 'hidden_for_filtered_view' ? (
              <p className="counts">
                {data.summary.note} <button onClick={() => setFullSummary(true)}>View full-topic summary</button>
              </p>
            ) : (
              <ul>
                {data.summary.claims.length ? <li className="counts cite-note">[1], [2]… are its sources: hover to preview the message, click to open it.</li> : null}
                {data.summary.claims.map((c) => (
                  <li key={c.id}>
                    {c.text}{' '}
                    {c.evidence.map((e) => {
                      // One number per message across the summary: the same [n] always opens the same message.
                      const i = srcNo.get(e.m)! - 1;
                      // The cited message, when it is in the list already loaded below.
                      const src = items.find((x): x is ContentMessage => !('attachment_id' in x) && x.message_id === e.m);
                      const tip = src ? `Source ${i + 1} — ${src.sender}: “${(src.snippet ?? '').slice(0, 160)}”. Click to open.` : `Source ${i + 1}: the message this point is based on. Click to open it.`;
                      return (
                        <button key={e.m} className="cite" title={tip} onClick={() => onOpenMessage(chatId, e.m)} aria-label={tip}>
                          [{i + 1}]
                        </button>
                      );
                    })}
                  </li>
                ))}
                {fullSummary ? <li className="counts">Full-topic summary (all dates and review states)</li> : null}
              </ul>
            )}
          </details>
        ) : null}
        {items.length === 0 && data ? (
          <p className="counts">{filter.status === 'missed' ? 'All caught up here. Switch to All to view every message.' : 'No matching content.'}</p>
        ) : (
          items.map((it) =>
            'attachment_id' in it ? (
              <div key={it.attachment_id} className="msg">
                <MediaView a={{ ...it, id: it.attachment_id }} onFetch={fetchFile} />
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
              <div key={it.message_id} className="msg msg-row">
                <div className="msg-open" {...openOnDoubleClick(() => onOpenMessage(chatId, it.message_id))}>
                  <div>
                    <strong>{it.sender}</strong> <span className="counts">{it.sent_at ? new Date(it.sent_at).toLocaleString('en-SG', { timeZone: filter.tz }) : 'Unknown time'}</span>{' '}
                    <span className={it.review === 'missed' ? 'missed' : 'readbadge'}>{it.review === 'missed' ? '● Missed' : '✓ Read'}</span>
                    {it.edited ? <span className="pill">edited</span> : null}
                    {it.attachment_count ? <span className="pill">📎 {it.attachment_count}</span> : null}
                  </div>
                  {it.snippet || !it.attachments?.length ? <div>{it.snippet ?? '(no text)'}</div> : null}
                  {/* Photos, videos and voice clips right in the list; other files by name. */}
                  {it.attachments?.map((a) =>
                    ['image', 'sticker', 'video', 'audio'].includes(a.media_type) ? (
                      <MediaView key={a.id} a={a} onFetch={fetchFile} />
                    ) : (
                      <div key={a.id} className="counts">
                        📎{' '}
                        {a.availability === 'cached' ? (
                          <a href={`/api/attachments/${a.id}/content`} target="_blank" rel="noopener noreferrer">
                            {a.filename ?? a.media_type}
                          </a>
                        ) : (
                          (a.filename ?? a.media_type)
                        )}
                      </div>
                    ),
                  )}
                  <div className="path">{it.topic_paths.map(pathText).join(' | ')}</div>
                </div>
                {/* Mark read straight from the list, without opening the message. */}
                {it.review === 'missed' ? (
                  <button className="mark-read" aria-label={`Mark message from ${it.sender} as read`} onClick={() => void markRead(it)}>
                    ✓ Read
                  </button>
                ) : null}
              </div>
            ),
          )
        )}
        {data?.next_cursor ? <button onClick={() => load(data.next_cursor!)}>Load more</button> : null}
      </div>
    </div>
  );
}
