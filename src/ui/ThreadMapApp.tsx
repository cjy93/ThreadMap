'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AskMap, type AskResult } from './AskMap';
import { Avatar } from './Avatar';
import { BuildProgress } from './BuildProgress';
import { api, authClient, filterParams, leaveAndDeleteAccount, qs, type FilterState } from './client';
import { ConnectPanel } from './ConnectPanel';
import { ManualContent } from './Manual';
import { NodeDrawer, SourceView } from './Drawer';
import { MapView } from './MapView';
import { OutlineView } from './OutlineView';
import { ThemeToggle } from './ThemeToggle';
import type { ChatSummary, MapNode, MapResponse } from './types';

const TZ = 'Asia/Singapore';
const DWELL_MS = 2000;

type SearchResult = AskResult;
/** Nemotron's answer to an Ask question, each point with the messages it comes from. */
interface AskAnswer {
  text: string;
  enough: boolean;
  points: { text: string; sources: { message_id: string; chat_id: string; sender: string; snippet: string }[] }[];
}
/** A message starred in WhatsApp, as listed in the Starred panel. */
interface StarredMessage {
  message_id: string;
  chat_id: string;
  chat_title: string;
  sender: string;
  snippet: string;
  sent_at: string | null;
  review: 'read' | 'missed';
  topic_path: string[];
}
type StarredState = { scope: 'chat' | 'all'; items: StarredMessage[] | null };
type AnswerState = { state: 'loading' } | { state: 'done'; answer: AskAnswer } | { state: 'none'; note: string };

export function ThreadMapApp({ mode }: { mode: 'private' | 'demo' }) {
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(initial.get('chat'));
  const [filter, setFilter] = useState<FilterState>({
    status: 'missed',
    tz: TZ,
    topics: [],
  });
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
  const [connectOpen, setConnectOpen] = useState(initial.get('setup') === '1');
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const [autoRead, setAutoRead] = useState(true);
  const [query, setQuery] = useState('');
  const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const [starred, setStarred] = useState<StarredState | null>(null);
  const askGen = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [olderNote, setOlderNote] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const refreshAnalysis = async (id: string) => {
    setRefreshing(true);
    try {
      await api(`/api/chats/${id}/refresh`, { method: 'POST' });
      await loadChats();
    } finally {
      setRefreshing(false);
    }
  };
  // The chat list slides away for a bigger map; the choice is remembered on this browser.
  const [navHidden, setNavHidden] = useState(false);
  useEffect(() => {
    // Read after hydration: the server render always shows the list.
    try {
      if (window.localStorage.getItem('tm-nav-hidden') === '1') setNavHidden(true);
    } catch {
      // Storage blocked: start with the list shown.
    }
  }, []);
  const toggleNav = () =>
    setNavHidden((h) => {
      try {
        window.localStorage.setItem('tm-nav-hidden', h ? '0' : '1');
      } catch {
        // Storage blocked: the toggle still works for this visit.
      }
      return !h;
    });
  // After an Ask the canvas shows its concept map until "Back to chat map".
  const [conceptMap, setConceptMap] = useState(false);
  const gen = useRef(0);
  const router = useRouter();

  const loadChats = useCallback(async () => {
    const r = await api<{ chats: ChatSummary[] }>('/api/chats');
    setChats(r.chats);
    setChatId((c) => c ?? r.chats[0]?.id ?? null);
  }, []);

  // Owners without a linked WhatsApp land on setup, so pairing is the first thing they see.
  useEffect(() => {
    if (mode !== 'private') return;
    api<{ connection: { state: string } }>('/api/whatsapp/status').then(
      (s) => {
        if (!['connected', 'reconnecting', 'paused'].includes(s.connection.state)) setConnectOpen(true);
      },
      () => undefined,
    );
  }, [mode]);

  const loadMap = useCallback(async () => {
    if (!chatId) return;
    const my = ++gen.current;
    const params = {
      ...filterParams(filter),
      // Every level loads; the map's branch toggles choose what is shown.
      max_topic_depth: 'all',
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
  }, [chatId, filter, focus, collapsed, offsets, showDiscussions]);

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
    setStarred(null);
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

  // A branch cut off by the visible-node cap opens on its own.
  const onExpand = useCallback((n: MapNode) => setFocus(n.id), []);
  const onRevealPath = (cid: string, topicId: string) => {
    setChatId(cid);
    setSelectedNode(topicId);
    setMessageId(null);
  };

  // Ask: describe what you are looking for; Nemotron turns it into terms and topics.
  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setAnswer(null);
      return setSearchRes(null);
    }
    const my = ++askGen.current;
    setStarred(null);
    setAsking(true);
    setAnswer(null);
    let res: SearchResult;
    try {
      res = await api<SearchResult>(`/api/ask?${qs({ q: query, ...filterParams(filter), chat: chatId ?? undefined })}`);
      setSearchRes(res);
      setConceptMap(true);
    } finally {
      setAsking(false);
    }
    // Then Nemotron reads the matches (and the chat's discussion summaries) and answers; this takes longer.
    setAnswer({ state: 'loading' });
    try {
      const r = await api<{ answer: AskAnswer | null; note?: string }>('/api/ask/answer', {
        method: 'POST',
        json: { q: res.query, chat: chatId ?? undefined, message_ids: res.results.map((x) => x.message_id) },
      });
      if (my !== askGen.current) return; // a newer question replaced this one
      setAnswer(r.answer ? { state: 'done', answer: r.answer } : { state: 'none', note: r.note ?? 'No answer.' });
    } catch (err) {
      if (my === askGen.current) setAnswer({ state: 'none', note: (err as Error).message });
    }
  };

  const chat = chats.find((c) => c.id === chatId);
  // Starred: messages starred in WhatsApp, for this chat or every opened chat.
  const openStarred = async (scope: 'chat' | 'all') => {
    setSelectedNode(null);
    setMessageId(null);
    setSearchRes(null);
    setStarred({ scope, items: null });
    try {
      const r = await api<{ messages: StarredMessage[] }>(`/api/starred?${qs({ chat: scope === 'chat' ? (chatId ?? undefined) : undefined })}`);
      setStarred((cur) => (cur?.scope === scope ? { scope, items: r.messages } : cur));
    } catch {
      setStarred((cur) => (cur?.scope === scope ? { scope, items: [] } : cur));
    }
  };
  const topicTitle = (id: string) => map?.nodes.find((n) => n.id === id)?.title ?? map?.hidden_selected_topics.find((h) => h.id === id)?.path.map((p) => p.title).join(' › ') ?? 'topic';

  if (connectOpen) {
    return (
      <div style={{ padding: 16 }}>
        <ConnectPanel
          refreshKey={refreshKey}
          qrTick={qrTick}
          onClose={() => setConnectOpen(false)}
          // A returning number moves this browser into its existing workspace;
          // reload so live updates and maps follow the account that was signed in.
          onLinked={() => window.location.assign('/app?setup=1')}
          onOpenChat={(cid) => {
            setConnectOpen(false);
            setChatId(cid);
            setSelectedNode(null);
            setMessageId(null);
            setFocus(null);
            setFilter((f) => ({ ...f, topics: [] }));
            void loadChats();
          }}
        />
      </div>
    );
  }

  return (
    <div className={`shell ${navHidden ? 'nav-hidden' : ''}`}>
      <nav className="left" id="chat-list" aria-label="Conversations" aria-hidden={navHidden} inert={navHidden}>
        <div className="left-head">
          <span className="brand">
            Thread<em>Map</em>
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            <ThemeToggle />
            <button onClick={() => (mode === 'private' ? void leaveAndDeleteAccount() : void authClient.signOut().then(() => router.push('/')))}>Sign out</button>
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
          <div key={c.id} className="chatrow">
            <button
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
              <Avatar title={c.title} url={c.avatar_url} size={40} />
              <span className="chatitem-text">
                <span className="chatitem-title">{c.title}</span>
                <span className="counts">
                  {c.message_count} messages · <span className="missed">{c.missed_count} missed</span>
                  {c.pending_analysis_count ? ` · ${c.pending_analysis_count} pending analysis` : ''}
                </span>
              </span>
            </button>
            {mode === 'private' ? (
              <button
                className="unopen"
                aria-label={`Unopen ${c.title}`}
                title="Unopen: stop saving this chat and delete its messages and map from ThreadMap (nothing changes in WhatsApp)"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Unopen ${c.title}? ThreadMap stops saving it and deletes its messages and map here, so it is not analysed again. Nothing changes in WhatsApp; you can open it again from Connect / manage WhatsApp.`,
                    )
                  )
                    return;
                  await api(`/api/chats/${c.id}/unopen`, { method: 'POST' });
                  if (c.id === chatId) {
                    setChatId(null);
                    setMap(null);
                    setSelectedNode(null);
                    setMessageId(null);
                  }
                  await loadChats();
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
        ))}
        {!chats.length ? <p className="counts">No chats yet. {mode === 'private' ? 'Connect WhatsApp and select chats.' : ''}</p> : null}
      </nav>

      <header className="topbar">
        <button
          className="menu-btn"
          aria-label={navHidden ? 'Show chat list' : 'Hide chat list'}
          aria-expanded={!navHidden}
          aria-controls="chat-list"
          title={navHidden ? 'Show chat list' : 'Hide chat list'}
          onClick={toggleNav}
        >
          {/* A tab on the chat list's edge: the arrow points where the list will go. */}
          <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden>
            <path d={navHidden ? 'M5 3l6 6-6 6' : 'M9 3L3 9l6 6'} stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <strong>{chat?.title ?? 'Select a chat'}</strong>
        {/* Nemotron runs only on request: messages that arrived since the last analysis wait here. */}
        {mode === 'private' && chat?.source === 'whatsapp' ? (
          <button
            className={chat.pending_analysis_count && !chat.analysis.pending_jobs ? 'primary' : undefined}
            disabled={refreshing || chat.analysis.pending_jobs > 0 || !chat.pending_analysis_count}
            title="Analyse new messages with NVIDIA Nemotron and update this map"
            onClick={() => void refreshAnalysis(chat.id)}
          >
            {refreshing || chat.analysis.pending_jobs > 0 ? 'Analysing…' : chat.pending_analysis_count ? `Refresh (${chat.pending_analysis_count} new)` : 'Up to date'}
          </button>
        ) : null}
        {mode === 'private' && chat?.source === 'whatsapp' ? (
          <button
            disabled={refreshing || chat.analysis.pending_jobs > 0}
            title="Throw away this map and let NVIDIA Nemotron build it again from the discussions already read. Messages and Read/Missed stay."
            onClick={async () => {
              if (!window.confirm(`Rebuild the map for ${chat.title} from scratch? The current topics, including any you renamed or moved, are replaced. Messages and Read/Missed are kept.`)) return;
              setRefreshing(true);
              try {
                await api(`/api/chats/${chat.id}/rebuild?fresh=1`, {
                  method: 'POST',
                });
                await loadChats();
                void loadMap();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            Rebuild map
          </button>
        ) : null}
        {mode === 'private' && chat?.source === 'whatsapp' ? (
          <button
            disabled={olderNote !== null}
            title="Ask WhatsApp (via your phone) for the older messages it still has, 50 at a time, up to the per-chat limit. They join the Refresh count."
            onClick={async () => {
              const id = chat.id;
              setOlderNote('Asking your phone for older messages…');
              try {
                const r = await api<{ limited?: boolean; note: string }>(`/api/chats/${id}/history`, { method: 'POST' });
                if (r.limited) setOlderNote(r.note);
                else {
                  setOlderNote('Loading older messages from your phone, 50 at a time: they keep arriving for a few minutes and join the Refresh count (WhatsApp may return fewer or none).');
                  // They arrive through the phone page by page; pick up the new counts as they come in.
                  for (const ms of [5000, 15000, 30000, 60000, 120000]) setTimeout(() => void loadChats(), ms);
                }
              } catch (e) {
                setOlderNote((e as Error).message);
              }
              setTimeout(() => setOlderNote(null), 12000);
            }}
          >
            Load older messages
          </button>
        ) : null}
        <form onSubmit={runSearch} role="search" className="askbox">
          <label className="visually-hidden" htmlFor="q">
            Ask about this chat
          </label>
          <input id="q" type="search" placeholder="Ask: e.g. where did we decide the venue? photos of the poster" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="primary" disabled={asking || !query.trim()}>
            {asking ? 'Thinking…' : 'Ask'}
          </button>
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
        <button aria-pressed={starred !== null} title="Messages you starred in WhatsApp" onClick={() => (starred ? setStarred(null) : void openStarred(chatId ? 'chat' : 'all'))}>
          ★ Starred
        </button>
        <button className="manual-btn" onClick={() => setManualOpen(true)}>
          📖 User manual
        </button>
      </header>

      <div className="status" role="status" aria-live="polite">
        {map ? (
          <>
            <span>
              Chat: {map.chat_totals.message_count} messages · {map.chat_totals.missed_count} missed
            </span>
            {map.chat_totals.pending_analysis_count ? (
              (() => {
                const total = map.chat_totals.message_count;
                const pct = total ? Math.round(((total - map.chat_totals.pending_analysis_count) / total) * 100) : 0;
                const running = Boolean(chat?.analysis.pending_jobs);
                return (
                  <span className="pending-status">
                    Pending analysis: {map.chat_totals.pending_analysis_count} (not yet in roots)
                    <span className="bp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Messages placed on the map">
                      {/* Striped and moving while Nemotron is working; a sliver shows even at 0%. */}
                      <span
                        style={{
                          width: `${running ? Math.max(pct, 4) : pct}%`,
                        }}
                        className={running ? 'busy' : undefined}
                      />
                    </span>
                    {pct}% on the map
                  </span>
                );
              })()
            ) : (
              <span>Pending analysis: 0</span>
            )}
            {olderNote ? <span>{olderNote}</span> : null}
            {chat?.analysis.budget_paused ? <span className="missed">Analysis paused by budget</span> : null}
            {chat?.analysis.pending_jobs ? (
              <span>Analysis running ({chat.analysis.pending_jobs})</span>
            ) : map.chat_totals.pending_analysis_count ? (
              <span className="missed">Map incomplete: some messages are not placed yet</span>
            ) : (
              <span>Analysis up to date for captured revisions</span>
            )}
            {filter.topics.map((t) => (
              <span key={t} className="pill">
                Topic: {topicTitle(t)}
                <button
                  aria-label="Remove topic filter"
                  style={{ padding: '0 4px' }}
                  onClick={() =>
                    setFilter({
                      ...filter,
                      topics: filter.topics.filter((x) => x !== t),
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </>
        ) : (
          <span>{mapError ?? 'Loading…'}</span>
        )}
      </div>

      <main className="center">
        {map && chat && chatId ? (
          <BuildProgress
            chatKey={chatId}
            total={map.chat_totals.message_count}
            pending={map.chat_totals.pending_analysis_count}
            jobs={chat.analysis.pending_jobs}
            failed={chat.analysis.failed}
            budgetPaused={chat.analysis.budget_paused}
            onRefresh={mode === 'private' && chat.source === 'whatsapp' && !refreshing ? () => void refreshAnalysis(chat.id) : undefined}
          />
        ) : null}
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
        {searchRes && conceptMap ? (
          <AskMap
            res={searchRes}
            onBack={() => setConceptMap(false)}
            onOpenTopic={(cid, id) => {
              setConceptMap(false);
              onRevealPath(cid, id);
            }}
            onOpenMessage={onOpenMessage}
          />
        ) : map && chatId ? (
          view === 'map' ? (
            <MapView map={map} selectedId={selectedNode} onOpen={onOpenNode} onExpand={onExpand} chatKey={chatId} />
          ) : (
            <OutlineView map={map} selectedId={selectedNode} onOpen={onOpenNode} onExpand={onExpand} />
          )
        ) : null}
      </main>

      {searchRes || selectedNode || messageId || starred ? (
        <aside className="drawer" aria-label="Details">
          {/* Stays at the top while the details below scroll. */}
          <div className="drawer-bar">
            <span className="counts">{messageId ? 'Source' : starred ? 'Starred' : searchRes ? 'Search' : 'Content'}</span>
            <span>
              {selectedNode && map?.nodes.find((n) => n.id === selectedNode && n.kind === 'TOPIC') ? <button onClick={() => setFocus(selectedNode)}>Focus branch</button> : null}{' '}
              {messageId && (selectedNode || starred) ? <button onClick={() => setMessageId(null)}>Back to list</button> : null}{' '}
              <button
                aria-label="Close details"
                onClick={() => {
                  setMessageId(null);
                  setSelectedNode(null);
                  setSearchRes(null);
                  setStarred(null);
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
          ) : starred ? (
            <div className="dbody">
              <div className="seg" role="group" aria-label="Starred in">
                <button aria-pressed={starred.scope === 'chat'} disabled={!chatId} onClick={() => void openStarred('chat')}>
                  This chat
                </button>
                <button aria-pressed={starred.scope === 'all'} onClick={() => void openStarred('all')}>
                  All chats
                </button>
              </div>
              {starred.items === null ? (
                <p className="counts">Loading…</p>
              ) : starred.items.length ? (
                <>
                  <p className="counts">
                    {starred.items.length} starred message{starred.items.length === 1 ? '' : 's'}, newest star first. Star or unstar on your phone; it follows here.
                  </p>
                  {starred.items.map((m) => (
                    <button key={m.message_id} className="msg" onClick={() => onOpenMessage(m.chat_id, m.message_id)}>
                      <strong>★ {m.sender}</strong> <span className={m.review === 'missed' ? 'missed' : 'readbadge'}>{m.review}</span>{' '}
                      <span className="counts">
                        {starred.scope === 'all' ? `${m.chat_title} · ` : ''}
                        {m.sent_at ? new Date(m.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                      </span>
                      <div>{m.snippet}</div>
                      {m.topic_path.length ? <div className="path">{m.topic_path.join(' › ')}</div> : null}
                    </button>
                  ))}
                </>
              ) : (
                <p className="counts">No starred messages {starred.scope === 'chat' ? 'in this chat' : 'in your opened chats'} yet. Star a message in WhatsApp on your phone and it appears here.</p>
              )}
            </div>
          ) : searchRes ? (
            <div className="dbody">
              <div className="bubble mine">{searchRes.query}</div>
              {!conceptMap ? (
                <button className="msg" onClick={() => setConceptMap(true)}>
                  Show concept map
                </button>
              ) : null}
              <div className="bubble">
                {searchRes.interpretation ?? 'Searching for these words (the model was not available):'}
                {searchRes.terms.length ? (
                  <div className="terms">
                    {searchRes.terms.map((t) => (
                      <span key={t} className="pill">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {answer ? (
                <div className="bubble answer" aria-live="polite">
                  {answer.state === 'loading' ? (
                    <span className="counts">NVIDIA Nemotron is reading the matching messages to answer…</span>
                  ) : answer.state === 'none' ? (
                    <span className="counts">{answer.note}</span>
                  ) : (
                    <>
                      <p>{answer.answer.text}</p>
                      {answer.answer.points.length ? (
                        <ul>
                          {answer.answer.points.map((p, i) => (
                            <li key={i}>
                              {p.text}{' '}
                              {p.sources.map((src, j) => (
                                <button key={src.message_id} className="cite" title={`${src.sender}: ${src.snippet}`} onClick={() => onOpenMessage(src.chat_id, src.message_id)}>
                                  [{j + 1}]
                                </button>
                              ))}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <span className="counts">Answered by NVIDIA Nemotron from your messages; click [n] to open a source.</span>
                    </>
                  )}
                </div>
              ) : null}
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
              onFilterTopic={(id) =>
                setFilter((f) => ({
                  ...f,
                  topics: f.topics.includes(id) ? f.topics : [...f.topics, id],
                }))
              }
              onRevealPath={onRevealPath}
            />
          ) : null}
        </aside>
      ) : null}

      {manualOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setManualOpen(false)} onKeyDown={(e) => e.key === 'Escape' && setManualOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="manual-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-bar">
              <h2 id="manual-title">User manual</h2>
              <span>
                <a href="/manual" target="_blank" rel="noreferrer">
                  Open in new tab
                </a>{' '}
                <button aria-label="Close user manual" autoFocus onClick={() => setManualOpen(false)}>
                  ✕
                </button>
              </span>
            </div>
            <ManualContent />
          </div>
        </div>
      ) : null}
    </div>
  );
}
