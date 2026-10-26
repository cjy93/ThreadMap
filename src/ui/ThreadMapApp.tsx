'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, authClient, filterParams, qs, type FilterState } from './client';
import { ConnectPanel } from './ConnectPanel';
import { NodeDrawer, SourceView } from './Drawer';
import { MapView } from './MapView';
import { OutlineView } from './OutlineView';
import { ThemeToggle } from './ThemeToggle';
import type { ChatSummary, MapNode, MapResponse, PathItem } from './types';

const TZ = 'Asia/Singapore';
const DWELL_MS = 2000;

interface SearchResult {
  results: { message_id: string; chat_id: string; sender: string; snippet: string; review: string; topic_paths: PathItem[][] }[];
  topics: { chat_id: string; topic_id: string; path: PathItem[] }[];
}

export function ThreadMapApp({ mode }: { mode: 'private' | 'demo' }) {
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(initial.get('chat'));
  const [filter, setFilter] = useState<FilterState>({ status: 'missed', tz: TZ, topics: [] });
  const [urlDepth, setUrlDepth] = useState<string | null>(initial.get('depth'));
  const [map, setMap] = useState<MapResponse | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'outline'>('map');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(initial.get('message'));
  const [collapsed] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [offsets] = useState<Record<string, number>>({});
  const [showDiscussions, setShowDiscussions] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [qrTick, setQrTick] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const [autoRead, setAutoRead] = useState(true);
  const [customDepth, setCustomDepth] = useState('');
  const [query, setQuery] = useState('');
  const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
  const gen = useRef(0);
  const router = useRouter();

  const loadChats = useCallback(async () => {
    const r = await api<{ chats: ChatSummary[] }>('/api/chats');
    setChats(r.chats);
    setChatId((c) => c ?? r.chats[0]?.id ?? null);
  }, []);

  const loadMap = useCallback(async () => {
    if (!chatId) return;
    const my = ++gen.current;
    const params = {
      ...filterParams(filter),
      max_topic_depth: urlDepth ?? undefined,
      focus: focus ?? undefined,
      collapsed: [...collapsed].join(',') || undefined,
      offsets: Object.entries(offsets).map(([k, v]) => `${k}:${v}`).join(',') || undefined,
      discussions: showDiscussions ? '1' : undefined,
    };
    try {
      const r = await api<MapResponse>(`/api/chats/${chatId}/map?${qs(params)}`);
      // Reject stale responses for an older filter/request.
      if (my !== gen.current) return;
      setMap(r);
      setMapError(null);
    } catch (e) {
      if (my === gen.current) setMapError((e as Error).message);
    }
  }, [chatId, filter, urlDepth, focus, collapsed, offsets, showDiscussions]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);
  useEffect(() => {
    void loadMap();
  }, [loadMap]);

  // Live updates: coalesce notices, then refetch authorized state by version.
  useEffect(() => {
    const es = new EventSource('/api/events');
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        void loadChats();
        void loadMap();
        setRefreshKey((k) => k + 1);
      }, 600);
    };
    es.addEventListener('change', bump);
    es.addEventListener('qr', () => setQrTick((q) => q + 1));
    es.onerror = () => bump(); // refetch after a gap; EventSource reconnects itself
    return () => {
      es.close();
      if (t) clearTimeout(t);
    };
  }, [loadChats, loadMap]);

  const onOpenNode = useCallback((id: string) => {
    setSelectedNode(id);
    setMessageId(null);
  }, []);
  const onOpenMessage = useCallback((cid: string, id: string) => {
    if (cid !== chatId) setChatId(cid);
    setMessageId(id);
    setSuppressed((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id); // deliberate reopen re-enables auto-read
      return n;
    });
  }, [chatId]);

  const setDepth = async (v: string) => {
    if (!chatId) return;
    setUrlDepth(null);
    await api(`/api/chats/${chatId}/view-preferences`, { method: 'PUT', json: { show_depth: v === 'all' ? 'all' : Number(v) } });
    void loadMap();
  };
  const onExpand = useCallback(
    (n: MapNode) => {
      // "Show next level" explicitly increases the displayed depth bound.
      void setDepth(String(n.depth + 1));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId],
  );
  const onRevealPath = (cid: string, topicId: string) => {
    setChatId(cid);
    setSelectedNode(topicId);
    setMessageId(null);
    setUrlDepth('all');
  };

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return setSearchRes(null);
    setSearchRes(await api<SearchResult>(`/api/search?${qs({ q: query, ...filterParams(filter), chat: chatId ?? undefined })}`));
  };

  const depthValue = map ? String(map.max_topic_depth) : '2';
  const depthOptions = useMemo(() => {
    const max = map?.available_max_topic_depth ?? 3;
    return [...new Set([0, 1, 2, 3, ...Array.from({ length: max + 1 }, (_, i) => i)])].sort((a, b) => a - b);
  }, [map?.available_max_topic_depth]);
  const chat = chats.find((c) => c.id === chatId);
  const topicTitle = (id: string) => map?.nodes.find((n) => n.id === id)?.title ?? map?.hidden_selected_topics.find((h) => h.id === id)?.path.map((p) => p.title).join(' › ') ?? 'topic';

  if (connectOpen) {
    return (
      <div style={{ padding: 16 }}>
        <ConnectPanel refreshKey={refreshKey} qrTick={qrTick} onClose={() => setConnectOpen(false)} />
      </div>
    );
  }

  return (
    <div className="shell">
      <nav className="left" aria-label="Conversations">
        <div className="left-head">
          <span className="brand">
            Thread<em>Map</em>
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            <ThemeToggle />
            <button onClick={() => authClient.signOut().then(() => router.push('/'))}>Sign out</button>
          </span>
        </div>
        {mode === 'demo' ? <p className="banner">Demo: labeled synthetic replay. Pairing disabled.</p> : null}
        <button style={{ width: '100%', margin: '8px 0' }} onClick={() => setConnectOpen(true)}>
          {mode === 'demo' ? 'About this demo' : 'Connect / manage WhatsApp'}
        </button>
        <div className="kicker" style={{ margin: '12px 0 6px' }}>
          Chats
        </div>
        {chats.map((c) => (
          <button
            key={c.id}
            className="chatitem"
            aria-current={c.id === chatId}
            onClick={() => {
              setChatId(c.id);
              setSelectedNode(null);
              setMessageId(null);
              setFocus(null);
              setFilter((f) => ({ ...f, topics: [] }));
            }}
          >
            <div>{c.title}</div>
            <div className="counts">
              {c.message_count} messages · <span className="missed">{c.missed_count} missed</span>
              {c.pending_analysis_count ? ` · ${c.pending_analysis_count} pending analysis` : ''}
            </div>
          </button>
        ))}
        {!chats.length ? <p className="counts">No chats yet. {mode === 'private' ? 'Connect WhatsApp and select chats.' : ''}</p> : null}
      </nav>

      <header className="topbar">
        <strong>{chat?.title ?? 'Select a chat'}</strong>
        <form onSubmit={runSearch} role="search">
          <label className="visually-hidden" htmlFor="q">
            Search
          </label>
          <input id="q" type="search" placeholder="Search messages, files, links, topics" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
        <label>
          From <input type="date" value={filter.from ?? ''} onChange={(e) => setFilter({ ...filter, from: e.target.value || undefined })} />
        </label>
        <label>
          To <input type="date" value={filter.to ?? ''} onChange={(e) => setFilter({ ...filter, to: e.target.value || undefined })} />
        </label>
        <div className="seg" role="group" aria-label="Review status filter">
          {(['missed', 'all', 'read'] as const).map((s) => (
            <button key={s} aria-pressed={filter.status === s} onClick={() => setFilter({ ...filter, status: s })}>
              {s === 'missed' ? 'Missed' : s === 'all' ? 'All' : 'Read'}
            </button>
          ))}
        </div>
        <label>
          Show depth{' '}
          <select aria-label="Show depth" value={depthOptions.includes(Number(depthValue)) || depthValue === 'all' ? depthValue : 'custom'} onChange={(e) => (e.target.value === 'custom' ? undefined : setDepth(e.target.value))}>
            {depthOptions.map((d) => (
              <option key={d} value={String(d)}>
                {d === 0 ? '0 (categories only)' : d}
              </option>
            ))}
            <option value="all">All levels</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        <input type="number" min={0} aria-label="Custom depth" style={{ width: 64 }} value={customDepth} placeholder="n" onChange={(e) => setCustomDepth(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && /^\d+$/.test(customDepth) && setDepth(customDepth)} />
        <span className="counts">of {map?.available_max_topic_depth ?? '…'} available</span>
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === 'map'} onClick={() => setView('map')}>
            Map
          </button>
          <button aria-pressed={view === 'outline'} onClick={() => setView('outline')}>
            Outline
          </button>
        </div>
        <label className="counts">
          <input type="checkbox" checked={showDiscussions} onChange={(e) => setShowDiscussions(e.target.checked)} /> discussions
        </label>
        <label className="counts">
          <input type="checkbox" checked={autoRead} onChange={(e) => setAutoRead(e.target.checked)} /> auto-read
        </label>
      </header>

      <div className="status" role="status" aria-live="polite">
        {map ? (
          <>
            <span>
              Chat: {map.chat_totals.message_count} messages · {map.chat_totals.missed_count} missed
            </span>
            <span>Pending analysis: {map.chat_totals.pending_analysis_count} (not yet in roots)</span>
            <span>
              Depth {String(map.max_topic_depth)} ({map.depth_source})
            </span>
            {chat?.analysis.budget_paused ? <span className="missed">Analysis paused by budget</span> : null}
            {chat?.analysis.pending_jobs ? <span>Analysis running ({chat.analysis.pending_jobs})</span> : <span>Analysis up to date for captured revisions</span>}
            {filter.topics.map((t) => (
              <span key={t} className="pill">
                Topic: {topicTitle(t)}
                {map.hidden_selected_topics.some((h) => h.id === t) ? ' (hidden at this depth)' : ''}
                <button aria-label="Remove topic filter" style={{ padding: '0 4px' }} onClick={() => setFilter({ ...filter, topics: filter.topics.filter((x) => x !== t) })}>
                  ×
                </button>
              </span>
            ))}
            {map.hidden_selected_topics.length ? <button onClick={() => setUrlDepth('all')}>Reveal selected path</button> : null}
          </>
        ) : (
          <span>{mapError ?? 'Loading…'}</span>
        )}
      </div>

      <main className="center">
        {map?.focus ? (
          <div className="breadcrumbs" aria-label="Breadcrumbs">
            <button onClick={() => setFocus(null)}>All roots</button>
            {map.focus.breadcrumbs.map((b) => (
              <button key={b.id} onClick={() => setFocus(b.id)}>
                {b.title} <span className="counts">d{b.depth}</span>
              </button>
            ))}
          </div>
        ) : null}
        {map && chatId ? (
          view === 'map' ? (
            <MapView map={map} selectedId={selectedNode} onOpen={onOpenNode} onExpand={onExpand} chatKey={chatId} />
          ) : (
            <OutlineView map={map} selectedId={selectedNode} onOpen={onOpenNode} onExpand={onExpand} />
          )
        ) : null}
      </main>

      {searchRes || selectedNode || messageId ? (
        <aside className="drawer" aria-label="Details">
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px' }}>
            <span className="counts">{messageId ? 'Source' : searchRes ? 'Search' : 'Content'}</span>
            <span>
              {selectedNode && map?.nodes.find((n) => n.id === selectedNode && n.kind === 'TOPIC') ? <button onClick={() => setFocus(selectedNode)}>Focus branch</button> : null}{' '}
              {messageId && selectedNode ? <button onClick={() => setMessageId(null)}>Back to list</button> : null}{' '}
              <button
                aria-label="Close details"
                onClick={() => {
                  setMessageId(null);
                  setSelectedNode(null);
                  setSearchRes(null);
                }}
              >
                ✕
              </button>
            </span>
          </div>
          {messageId ? (
            <div className="dbody">
              <SourceView
                key={messageId}
                messageId={messageId}
                tz={filter.tz}
                dwellMs={DWELL_MS}
                autoRead={autoRead}
                suppressed={suppressed.has(messageId)}
                onSuppress={(id) => setSuppressed((s) => new Set(s).add(id))}
                onChanged={() => {
                  void loadMap();
                  void loadChats();
                }}
                onOpenMessage={onOpenMessage}
              />
            </div>
          ) : searchRes ? (
            <div className="dbody">
              {searchRes.topics.map((t) => (
                <button key={t.topic_id} className="msg" onClick={() => onRevealPath(t.chat_id, t.topic_id)}>
                  Topic: {t.path.map((p) => p.title).join(' › ')}
                </button>
              ))}
              {searchRes.results.map((r) => (
                <button key={r.message_id} className="msg" onClick={() => onOpenMessage(r.chat_id, r.message_id)}>
                  <strong>{r.sender}</strong> <span className={r.review === 'missed' ? 'missed' : 'readbadge'}>{r.review}</span>
                  <div>{r.snippet}</div>
                  <div className="path">{r.topic_paths.map((p) => p.map((x) => x.title).join(' › ')).join(' | ')}</div>
                </button>
              ))}
              {!searchRes.results.length && !searchRes.topics.length ? <p className="counts">No matches under the current filters.</p> : null}
            </div>
          ) : selectedNode && chatId ? (
            <NodeDrawer
              chatId={chatId}
              nodeId={selectedNode}
              filter={filter}
              refreshKey={refreshKey}
              onOpenMessage={onOpenMessage}
              onChanged={() => {
                void loadMap();
                void loadChats();
              }}
              onFilterTopic={(id) => setFilter((f) => ({ ...f, topics: f.topics.includes(id) ? f.topics : [...f.topics, id] }))}
              onRevealPath={onRevealPath}
            />
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
