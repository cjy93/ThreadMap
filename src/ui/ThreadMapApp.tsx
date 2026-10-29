'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AskMap, type AskResult } from './AskMap';
import { StudyMapView } from './StudyMap';
import { Avatar } from './Avatar';
import { BuildProgress } from './BuildProgress';
import { api, authClient, filterParams, leaveAndDeleteAccount, openOnDoubleClick, qs, sourceNumbers, type FilterState } from './client';
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
// A chat's one-sided maps: built from only the owner's messages, or only the others'.
type MapSideChoice = 'mine' | 'others';
/** Nemotron's answer to an Ask question, each point with the messages it comes from. */
interface AskAnswer {
  text: string;
  enough: boolean;
  read: { messages: number; discussions: number } | null;
  points: { text: string; sources: { message_id: string; chat_id: string; sender: string; snippet: string }[] }[];
}
/** A small-talk message left off the map, as listed in the Small talk panel. */
interface SmallTalkMessage {
  message_id: string;
  chat_id: string;
  sender: string;
  snippet: string;
  sent_at: string | null;
  review: 'read' | 'missed';
}
interface SmallTalkState {
  chatId: string;
  items: SmallTalkMessage[] | null;
  total: number;
  next: number | null;
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
type AnswerState = { state: 'loading'; note?: string } | { state: 'done'; answer: AskAnswer } | { state: 'none'; note: string };

export function ThreadMapApp({ mode, ownAccount = false }: { mode: 'private' | 'demo'; ownAccount?: boolean }) {
  const initial = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  // Refreshing the app goes to the landing page (the owner's choice); links and buttons into
  // the app still open it directly.
  useEffect(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === 'reload') window.location.replace('/');
  }, []);
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [qrTick, setQrTick] = useState(0);
  const [connectOpen, setConnectOpen] = useState(initial.get('setup') === '1');
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const [starred, setStarred] = useState<StarredState | null>(null);
  // Small talk left off the map, listed on request so the owner can check nothing important went.
  const [smallTalk, setSmallTalk] = useState<SmallTalkState | null>(null);
  const askGen = useRef(0);
  // The current search's parameters, to fetch further pages of its matches as the list scrolls.
  const askParamsRef = useRef<Record<string, string | undefined> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Chips under Nemotron's reading picked to narrow the list, and that narrowed list.
  const [chipSel, setChipSel] = useState<string[]>([]);
  const [chipRes, setChipRes] = useState<SearchResult | null>(null);
  // Each chip click supersedes the last: a slower earlier filter never lands over a newer one.
  const chipGen = useRef(0);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The question being searched right now (null when idle). A new question may be asked at any
  // time, e.g. to fix a typo; it replaces this one, whose late results are then ignored.
  const [asking, setAsking] = useState<string | null>(null);
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
  // Opened branches whose topics the map's node budget left out (see onExpand).
  const [deeper, setDeeper] = useState<string[]>([]);
  // "Map from" choice per chat (see chooseSide below).
  const [mapSides, setMapSides] = useState<Record<string, MapSideChoice>>({});
  // The chat list slides away for a bigger map; the choice is remembered on this browser.
  const [navHidden, setNavHidden] = useState(false);
  useEffect(() => {
    // Read after hydration: the server render always shows the list.
    try {
      if (window.localStorage.getItem('tm-nav-hidden') === '1') setNavHidden(true);
      setMapSides(JSON.parse(window.localStorage.getItem('tm-map-sides') ?? '{}') as Record<string, MapSideChoice>);
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
  // "Map from": the chat's own map (everyone's messages), or a separate map built from only the
  // owner's or only the others' messages. Chosen per chat and remembered on this browser.
  const side = chatId ? mapSides[chatId] : undefined;
  // What the server is asked for: the filters plus the chosen map.
  const viewFilter = useMemo<FilterState>(() => (side ? { ...filter, side } : filter), [filter, side]);
  const [sideNote, setSideNote] = useState<string | null>(null);
  const chooseSide = async (next: MapSideChoice | 'all') => {
    if (!chatId) return;
    setSideNote(null);
    if (next !== 'all') {
      try {
        // Starts the map the first time; afterwards brings it up to date.
        await api(`/api/chats/${chatId}/side-map`, { method: 'POST', json: { side: next } });
      } catch (e) {
        setSideNote((e as Error).message);
        return;
      }
    }
    setMapSides((m) => {
      const out = { ...m };
      if (next === 'all') delete out[chatId];
      else out[chatId] = next;
      try {
        window.localStorage.setItem('tm-map-sides', JSON.stringify(out));
      } catch {
        // Storage blocked: the choice still applies for this visit.
      }
      return out;
    });
  };
  // The controls fold up while you read a topic or an answer; the ▾ tab brings them back.
  const [headFolded, setHeadFolded] = useState(false);
  // Messages opened one from another (e.g. within a discussion); Back walks this trail.
  const [msgTrail, setMsgTrail] = useState<string[]>([]);
  // After an Ask the canvas shows its concept map until "Back to mind map".
  const [conceptMap, setConceptMap] = useState(false);
  // The message whose concept map (study guide) fills the canvas, until "Back to mind map".
  const [studyFor, setStudyFor] = useState<string | null>(null);
  // On a concept map the Source panel starts hidden, so the concept card takes its place;
  // "Show source message" (or ✕ to hide again) toggles it while that map is open.
  const [sourceHidden, setSourceHidden] = useState(true);
  const openStudy = (id: string) => {
    setStudyFor(id);
    setSourceHidden(true);
  };
  const studySourceShown = Boolean(studyFor) && !sourceHidden;
  const gen = useRef(0);
  const router = useRouter();

  const loadChats = useCallback(async () => {
    const r = await api<{ chats: ChatSummary[] }>('/api/chats');
    setChats(r.chats);
    setChatId((c) => c ?? r.chats[0]?.id ?? null);
  }, []);

  // While this page is open it checks in every minute. With no ThreadMap page open for a while
  // (30 minutes by default) the account is deleted, as if "Disconnect and delete my data" was pressed.
  useEffect(() => {
    if (mode !== 'private') return;
    const ping = () => void api('/api/presence', { method: 'POST' }).catch(() => undefined);
    ping();
    const t = setInterval(ping, 60_000);
    const onShow = () => document.visibilityState === 'visible' && ping();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [mode]);

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
      ...filterParams(viewFilter),
      // Every level loads; the map's branch toggles choose what is shown.
      max_topic_depth: 'all',
      focus: focus ?? undefined,
      collapsed: [...collapsed].join(',') || undefined,
      offsets: Object.entries(offsets).map(([k, v]) => `${k}:${v}`).join(',') || undefined,
      expand: deeper.join(',') || undefined,
    };
    try {
      const r = await api<MapResponse>(`/api/chats/${chatId}/map?${qs(params)}`);
      // Reject stale responses for an older filter/request.
      if (my !== gen.current) return;
      setMap(r);
      setMapError(null);
    } catch (e) {
      if (my !== gen.current) return;
      // A remembered one-sided map that is not there (e.g. the chat was unopened since): start it again.
      if (viewFilter.side && /not been started/.test((e as Error).message)) {
        await api(`/api/chats/${chatId}/side-map`, { method: 'POST', json: { side: viewFilter.side } }).catch(() => undefined);
        const r = await api<MapResponse>(`/api/chats/${chatId}/map?${qs(params)}`).catch((e2: Error) => e2);
        if (my !== gen.current) return;
        if (r instanceof Error) setMapError(r.message);
        else {
          setMap(r);
          setMapError(null);
        }
        return;
      }
      setMapError((e as Error).message);
    }
  }, [chatId, viewFilter, focus, collapsed, offsets, deeper]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);
  useEffect(() => {
    void loadMap();
  }, [loadMap]);
  // While the phone may still be sending an empty chat's history, look again in a minute
  // (if nothing arrives, no live update would otherwise end the "Loading" note).
  const historyLoading = Boolean(map?.history_loading && map.chat_totals.message_count === 0);
  useEffect(() => {
    if (!historyLoading) return;
    const t = setTimeout(() => void loadMap(), 60_000);
    return () => clearTimeout(t);
  }, [historyLoading, loadMap]);

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

  // Leaving an Ask for the map: the box empties and its results go, so nothing looks filtered by it.
  const clearAsk = useCallback(() => {
    askGen.current++;
    setQuery('');
    setSearchRes(null);
    setAnswer(null);
    setConceptMap(false);
  }, []);
  const onOpenNode = useCallback(
    (id: string) => {
      clearAsk();
      setSelectedNode(id);
      setMessageId(null);
      setStarred(null);
      setSmallTalk(null);
      setHeadFolded(true);
    },
    [clearAsk],
  );
  const onOpenMessage = useCallback((cid: string, id: string) => {
    if (cid !== chatId) setChatId(cid);
    // From another message: remember it for Back. From a list: start a new trail.
    setMsgTrail((t) => (messageId && messageId !== id ? [...t, messageId] : messageId ? t : []));
    setMessageId(id);
    // Opening a message (e.g. a concept's source) shows the Source panel, also on a concept map.
    setSourceHidden(false);
    setSuppressed((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id); // deliberate reopen re-enables auto-read
      return n;
    });
  }, [chatId, messageId]);
  const goBack = () => {
    const prev = msgTrail.at(-1);
    setMsgTrail((t) => t.slice(0, -1));
    setMessageId(prev ?? null);
  };

  // A branch cut off by the visible-node cap opens on its own.
  // A branch whose topics were left out (the map sends a limited number of nodes) loads them when opened.
  const onExpand = useCallback((n: MapNode) => setDeeper((cur) => (cur.includes(n.id) ? cur : [...cur, n.id])), []);
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
    chipGen.current++;
    setChipSel([]);
    setChipRes(null);
    setStarred(null);
    setSmallTalk(null);
    setAsking(query);
    setAnswer(null);
    let res: SearchResult;
    try {
      const askParams = { q: query, ...filterParams(viewFilter), chat: chatId ?? undefined };
      askParamsRef.current = askParams;
      res = await api<SearchResult>(`/api/ask?${qs(askParams)}`);
      if (my !== askGen.current) return; // a newer question replaced this one
      setSearchRes(res);
      setConceptMap(true);
      setHeadFolded(true);
      // Nemotron was slow to read the question: once its reading arrives, search again with it.
      if (res.interpretation_pending) {
        const pendingId = res.interpretation_pending;
        void waitForLate(my, pendingId).then(async (late) => {
          if (my !== askGen.current || late?.state !== 'done') return;
          const again = await api<SearchResult>(`/api/ask?${qs({ ...askParams, interp: pendingId })}`).catch(() => null);
          if (again && my === askGen.current) setSearchRes(again);
        });
      }
    } finally {
      if (my === askGen.current) setAsking(null);
    }
    // Then Nemotron reads the matches (and the chat's discussion summaries) and answers; this takes longer.
    setAnswer({ state: 'loading' });
    try {
      const r = await api<{ answer: AskAnswer | null; note?: string; pending?: string }>('/api/ask/answer', {
        method: 'POST',
        json: { q: res.query, chat: chatId ?? undefined, message_ids: res.results.map((x) => x.message_id), words: (res.word_hits ?? []).flatMap((h) => h.words.map((w) => w.word)) },
      });
      if (my !== askGen.current) return; // a newer question replaced this one
      if (r.pending) {
        // Still working: keep the loading note and collect the answer when it is ready.
        setAnswer({ state: 'loading', note: r.note });
        const late = await waitForLate(my, r.pending);
        if (my !== askGen.current) return;
        setAnswer(late?.state === 'done' && late.answer ? { state: 'done', answer: late.answer } : { state: 'none', note: late?.note ?? 'NVIDIA Nemotron did not finish the answer; the matching messages are listed below.' });
        return;
      }
      setAnswer(r.answer ? { state: 'done', answer: r.answer } : { state: 'none', note: r.note ?? 'No answer.' });
    } catch (err) {
      if (my === askGen.current) setAnswer({ state: 'none', note: (err as Error).message });
    }
  };
  // The list shown: every match, or only those with the chips picked under Nemotron's reading.
  const filtering = chipSel.length > 0;
  const listRes = filtering ? chipRes : searchRes;
  const shownResults = listRes?.results ?? [];
  // A page of matches with the given words (no new model call); topics only for the full list.
  const fetchPage = useCallback(
    (terms: string[], topics: string[], offset: number) =>
      api<SearchResult>(`/api/ask?${qs({ ...askParamsRef.current, terms_json: JSON.stringify(terms), topics: topics.join(','), offset: String(offset) })}`),
    [],
  );
  const toggleChip = async (term: string) => {
    if (!searchRes || !askParamsRef.current) return;
    const next = chipSel.includes(term) ? chipSel.filter((t) => t !== term) : [...chipSel, term];
    setChipSel(next);
    setChipRes(null);
    const mine = ++chipGen.current;
    if (!next.length) return;
    const my = askGen.current;
    const r = await fetchPage(next, [], 0).catch(() => null);
    // Only if the question and the picked chips are still the same.
    if (r && my === askGen.current && mine === chipGen.current) setChipRes(r);
  };
  // The next page of the shown list, with the same words and topics (no new model call).
  const nextOffset = listRes?.next_offset ?? null;
  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMore || !listRes || !searchRes || !askParamsRef.current) return;
    const my = askGen.current;
    setLoadingMore(true);
    try {
      const more = await fetchPage(filtering ? chipSel : searchRes.terms, filtering ? [] : searchRes.topics.map((t) => t.topic_id), nextOffset);
      if (my !== askGen.current) return;
      const add = (cur: SearchResult | null) => {
        if (!cur) return cur;
        const seen = new Set(cur.results.map((r) => r.message_id));
        return { ...cur, results: [...cur.results, ...more.results.filter((r) => !seen.has(r.message_id))], total: more.total, next_offset: more.next_offset };
      };
      if (filtering) setChipRes(add);
      else setSearchRes(add);
    } finally {
      setLoadingMore(false);
    }
  }, [nextOffset, loadingMore, listRes, searchRes, filtering, chipSel, fetchPage]);
  // Reaching the end of the list loads the next page.
  useEffect(() => {
    const el = moreRef.current;
    if (!el || nextOffset === null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [nextOffset, loadMore]);
  // The Ask map stays readable: it draws the best matches (the first page), the list has them all.
  const askMapRes = useMemo(() => (searchRes ? { ...searchRes, results: searchRes.results.slice(0, 100) } : null), [searchRes]);
  // A slow Nemotron reply: check every few seconds for up to five minutes, while this question is current.
  const waitForLate = async (my: number, id: string) => {
    for (let i = 0; i < 75 && my === askGen.current; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const late = await api<{ state: string; answer?: AskAnswer; note?: string }>(`/api/ask/late/${id}`).catch(() => null);
      if (late && late.state !== 'pending') return late;
    }
    return null;
  };

  const chat = chats.find((c) => c.id === chatId);
  // The shown map's analysis: the chat's own, or the one-sided map's.
  const analysis = map?.analysis ?? chat?.analysis;
  // Starred: messages starred in WhatsApp, for this chat or every opened chat.
  const openSmallTalk = async (cid: string, offset = 0) => {
    if (!offset) {
      setSelectedNode(null);
      setMessageId(null);
      setSearchRes(null);
      setStarred(null);
      setSmallTalk({ chatId: cid, items: null, total: 0, next: null });
    }
    try {
      const r = await api<{ messages: SmallTalkMessage[]; total: number; next_offset: number | null }>(`/api/chats/${cid}/small-talk?${qs({ offset: offset ? String(offset) : undefined })}`);
      setSmallTalk((cur) => (cur?.chatId === cid ? { chatId: cid, items: [...(offset ? (cur.items ?? []) : []), ...r.messages], total: r.total, next: r.next_offset } : cur));
    } catch {
      setSmallTalk((cur) => (cur?.chatId === cid ? { ...cur, items: cur.items ?? [] } : cur));
    }
  };
  const openStarred = async (scope: 'chat' | 'all') => {
    setSmallTalk(null);
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
    <div className={`shell ${navHidden ? 'nav-hidden' : ''} ${headFolded || (searchRes && conceptMap) ? 'head-folded' : ''}`}>
      <nav className="left" id="chat-list" aria-label="Conversations" aria-hidden={navHidden} inert={navHidden}>
        <div className="left-head">
          {/* Home: the landing page (?home=1, since signed-in visitors are otherwise sent back here). */}
          <a href="/?home=1" className="brand" title="ThreadMap home" style={{ textDecoration: 'none', color: 'inherit' }}>
            Thread<em>Map</em>
          </a>
          <span style={{ display: 'flex', gap: 4 }}>
            <ThemeToggle />
            {mode === 'demo' && ownAccount ? (
              // Viewing the demo from a WhatsApp account: leave the demo, keep the account.
              <button onClick={() => window.location.assign('/api/view?to=mine')}>My chats</button>
            ) : (
              <button onClick={() => (mode === 'private' ? void leaveAndDeleteAccount() : void authClient.signOut().then(() => router.push('/')))}>Sign out</button>
            )}
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
                setDeeper([]);
                setFilter((f) => ({ ...f, topics: [] }));
                // Another chat: the last chat's Ask (map, answer, panel) goes, and the controls come back.
                askGen.current++;
                setQuery('');
                setSearchRes(null);
                setAnswer(null);
                setConceptMap(false);
                setStudyFor(null);
                setStarred(null);
                setSmallTalk(null);
                setMsgTrail([]);
                setHeadFolded(false);
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
            disabled={refreshing || chat.analysis.pending_jobs > 0}
            title="Analyse new messages with NVIDIA Nemotron and update this map; with nothing new, tidy the map if a level is too wide or repeats its parent"
            onClick={() => void refreshAnalysis(chat.id)}
          >
            {refreshing || chat.analysis.pending_jobs > 0 ? 'Analysing…' : chat.pending_analysis_count ? `Refresh (${chat.pending_analysis_count} new)` : 'Refresh'}
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
          <button className="primary" disabled={!query.trim()} title={asking !== null ? 'Ask again: a new question replaces the one still running' : undefined}>
            {asking !== null && asking === query ? 'Thinking…' : 'Ask'}
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
        {mode === 'private' && chat?.source === 'whatsapp' ? (
          <div className="seg" role="group" aria-label="Map from" title="Build the map from everyone's messages, only the others', or only yours. Each side gets its own map, so what the others said never shapes yours. The first time, NVIDIA Nemotron builds it (a few minutes for a long chat).">
            {(['all', 'others', 'mine'] as const).map((k) => (
              <button key={k} aria-pressed={(side ?? 'all') === k} onClick={() => void chooseSide(k)}>
                {k === 'all' ? 'Everyone' : k === 'others' ? 'Others' : 'You'}
              </button>
            ))}
          </div>
        ) : null}
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === 'map'} onClick={() => setView('map')}>
            Map
          </button>
          <button aria-pressed={view === 'outline'} onClick={() => setView('outline')}>
            Outline
          </button>
        </div>
        <button aria-pressed={starred !== null} title="Messages you starred in WhatsApp" onClick={() => (starred ? setStarred(null) : void openStarred(chatId ? 'chat' : 'all'))}>
          ★ Starred
        </button>
        <button className="manual-btn" onClick={() => setManualOpen(true)}>
          📖 User manual
        </button>
        {/* The controls belong to the mind map; on the Ask map the way back to it takes their place. */}
        {searchRes && conceptMap ? (
          <button className="fold-btn" title="Leave the Ask map for this chat's mind map (its controls come back)" onClick={() => {
            setConceptMap(false);
            setHeadFolded(false);
          }}>
            ← Back to mind map
          </button>
        ) : (
          <button
            className="fold-btn"
            aria-expanded={!headFolded}
            aria-controls="chat-status"
            title={headFolded ? 'Show the controls and status' : 'Fold the controls up for more room'}
            onClick={() => setHeadFolded((f) => !f)}
          >
            {headFolded ? '▾ Show controls' : '▴'}
          </button>
        )}
      </header>

      <div className="status" id="chat-status" role="status" aria-live="polite">
        {map ? (
          <>
            <span>
              Chat: {map.chat_totals.message_count} messages · {map.chat_totals.missed_count} missed · {map.chat_totals.message_count - map.chat_totals.missed_count} read
            </span>
            {map.chat_totals.filler_count ? (
              <button
                className="status-link"
                aria-pressed={smallTalk !== null}
                title="Messages that add nothing on their own (“ok”, “lol”, throwaway quips) are not counted or listed on the map, so its counts add up to less than the chat's. Click to list them and check nothing important was left out."
                onClick={() => (smallTalk ? setSmallTalk(null) : chatId ? void openSmallTalk(chatId) : undefined)}
              >
                {map.chat_totals.filler_count} small-talk messages left off the map · {smallTalk ? 'hide' : 'show them'}
              </button>
            ) : null}
            {map.chat_totals.pending_analysis_count ? (
              (() => {
                const total = map.chat_totals.message_count;
                const pct = total ? Math.round(((total - map.chat_totals.pending_analysis_count) / total) * 100) : 0;
                const running = Boolean(analysis?.pending_jobs);
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
            {side ? <span className="pill">{side === 'mine' ? 'Map from your messages only' : 'Map from the others’ messages only'}</span> : null}
            {sideNote ? <span className="missed">{sideNote}</span> : null}
            {analysis?.budget_paused ? <span className="missed">Analysis paused by budget</span> : null}
            {analysis?.pending_jobs ? (
              <span>Analysis running ({analysis.pending_jobs})</span>
            ) : map.chat_totals.pending_analysis_count ? (
              <span className="missed">Map incomplete: some messages are not placed yet{mode === 'private' && chat?.source === 'whatsapp' ? ' — click Refresh to analyse them' : ''}</span>
            ) : (
              <span>Analysis up to date for captured revisions</span>
            )}
          </>
        ) : (
          <span>{mapError ?? 'Loading…'}</span>
        )}
      </div>

      <main className="center">
        {map && chat && map.chat_totals.message_count === 0 ? (
          (() => {
            // A chat with nothing saved yet: say why and what to do, instead of four empty circles.
            const asked = map.history_requested_at !== null;
            const waiting = map.history_loading;
            return (
              <div className="empty-chat" role="status">
                <h3>{waiting ? 'Loading this chat from your phone…' : 'No messages saved for this chat yet'}</h3>
                {waiting ? (
                  <p>ThreadMap asked your phone for this chat’s recent messages. They usually arrive within a minute and the map fills in on its own. Keep WhatsApp open on your phone and connected to the internet.</p>
                ) : (
                  <>
                    <p>
                      WhatsApp only sends a chat’s full history once, when you link your phone, and ThreadMap does not keep messages of chats you have not opened.
                      {asked ? ' ThreadMap asked your phone for this chat’s recent messages, but none came back yet.' : ''}
                    </p>
                    <ul>
                      <li>Open WhatsApp on your phone (so it is online), then click <strong>Load older messages</strong> to ask again.</li>
                      <li>New messages in this chat are saved as they arrive; then click <strong>Refresh</strong> to put them on the map.</li>
                    </ul>
                  </>
                )}
              </div>
            );
          })()
        ) : null}
        {map && chat && chatId ? (
          <BuildProgress
            chatKey={chatId}
            total={map.chat_totals.message_count}
            pending={map.chat_totals.pending_analysis_count}
            jobs={analysis?.pending_jobs ?? 0}
            unread={analysis?.unread_messages ?? 0}
            failed={Boolean(analysis?.failed)}
            budgetPaused={Boolean(analysis?.budget_paused)}
            onRefresh={mode === 'private' && chat.source === 'whatsapp' && !refreshing ? () => void refreshAnalysis(chat.id) : undefined}
          />
        ) : null}
        {map?.focus ? (
          <div className="breadcrumbs" aria-label="Breadcrumbs">
            <button
              onClick={() => {
                setFocus(null);
                clearAsk();
              }}
            >
              All roots
            </button>
            {map.focus.breadcrumbs.map((b) => (
              <button key={b.id} onClick={() => setFocus(b.id)}>
                {b.title} <span className="counts">d{b.depth}</span>
              </button>
            ))}
          </div>
        ) : null}
        {studyFor ? (
          <StudyMapView
            key={studyFor}
            messageId={studyFor}
            onBack={() => setStudyFor(null)}
            onOpenMessage={onOpenMessage}
            sourceShown={studySourceShown}
            onToggleSource={() => {
              if (sourceHidden && !messageId) setMessageId(studyFor);
              setSourceHidden(!sourceHidden);
            }}
          />
        ) : searchRes && conceptMap ? (
          <AskMap
            res={askMapRes!}
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

      {(searchRes || selectedNode || messageId || starred || smallTalk) && !(studyFor && sourceHidden) ? (
        <aside className="drawer" aria-label="Details">
          {/* Stays at the top while the details below scroll. */}
          <div className="drawer-bar">
            <span className="counts">{messageId ? 'Source' : smallTalk ? 'Small talk' : starred ? 'Starred' : searchRes ? 'Ask results' : 'Content'}</span>
            <span>
              {/* Focus toggles: narrow the map to this bubble's branch, or go back to the whole map to pick another. */}
              {selectedNode && selectedNode !== focus && map?.nodes.find((n) => n.id === selectedNode && n.kind === 'TOPIC') ? (
                <button title="Show only this bubble and what is beneath it" onClick={() => setFocus(selectedNode)}>
                  Focus branch
                </button>
              ) : null}{' '}
              {focus ? (
                <button aria-pressed title="Show the whole map again, to pick another bubble" onClick={() => setFocus(null)}>
                  Full map
                </button>
              ) : null}{' '}
              {messageId && (msgTrail.length || selectedNode || starred || smallTalk || searchRes) ? (
                <button title={msgTrail.length ? 'Back to the message you came from' : 'Back to the list'} onClick={goBack}>
                  ← Back
                </button>
              ) : null}{' '}
              <button
                aria-label="Close details"
                onClick={() => {
                  // On a concept map, only hide the panel: "Show source message" brings it back.
                  if (studyFor) {
                    setSourceHidden(true);
                    return;
                  }
                  setMessageId(null);
                  setMsgTrail([]);
                  setSelectedNode(null);
                  setSearchRes(null);
                  setStarred(null);
                  setSmallTalk(null);
                  setHeadFolded(false);
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
                suppressed={suppressed.has(messageId)}
                onSuppress={(id) => setSuppressed((s) => new Set(s).add(id))}
                onChanged={() => {
                  void loadMap();
                  void loadChats();
                }}
                onOpenMessage={onOpenMessage}
                onConceptMap={openStudy}
              />
            </div>
          ) : smallTalk ? (
            <div className="dbody">
              {smallTalk.items === null ? (
                <p className="counts">Loading…</p>
              ) : smallTalk.items.length ? (
                <>
                  <p className="counts">
                    {smallTalk.total.toLocaleString('en-US')} small-talk message{smallTalk.total === 1 ? '' : 's'} left off this chat’s map, newest first. Double-click one to open it in its discussion and check nothing important was screened out.
                  </p>
                  {smallTalk.items.map((m) => (
                    <div key={m.message_id} className="msg small-talk" {...openOnDoubleClick(() => onOpenMessage(m.chat_id, m.message_id))}>
                      <strong>{m.sender}</strong> <span className={m.review === 'missed' ? 'missed' : 'readbadge'}>{m.review}</span>{' '}
                      <span className="counts">{m.sent_at ? new Date(m.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
                      <div>{m.snippet}</div>
                    </div>
                  ))}
                  {smallTalk.next !== null ? (
                    <div className="ask-more">
                      <button onClick={() => void openSmallTalk(smallTalk.chatId, smallTalk.next!)}>Load more ({(smallTalk.total - smallTalk.items.length).toLocaleString('en-US')} left)</button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="counts">No small talk was left off this chat’s map.</p>
              )}
            </div>
          ) : starred ? (
            <div className="dbody">
              {/* Every message starred anywhere in this chat, whether or not it is on the map. */}
              {starred.items === null ? (
                <p className="counts">Loading…</p>
              ) : starred.items.length ? (
                <>
                  <p className="counts">
                    {starred.items.length} starred message{starred.items.length === 1 ? '' : 's'} in this chat, newest star first. Star or unstar on your phone; it follows here.
                  </p>
                  {starred.items.map((m) => (
                    <div key={m.message_id} className="msg" {...openOnDoubleClick(() => onOpenMessage(m.chat_id, m.message_id))}>
                      <strong>★ {m.sender}</strong> <span className={m.review === 'missed' ? 'missed' : 'readbadge'}>{m.review}</span>{' '}
                      <span className="counts">
                        {starred.scope === 'all' ? `${m.chat_title} · ` : ''}
                        {m.sent_at ? new Date(m.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                      </span>
                      <div>{m.snippet}</div>
                      {m.topic_path.length ? <div className="path">{m.topic_path.join(' › ')}</div> : null}
                    </div>
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
                <button
                  className="ask-action"
                  onClick={() => {
                    setConceptMap(true);
                    setHeadFolded(true);
                  }}
                >
                  ◇ Show concept map →
                </button>
              ) : null}
              <div className="bubble ai-read">
                <div className="ask-label">{searchRes.interpretation ? 'Nemotron’s reading' : 'Search'}</div>
                {searchRes.interpretation ?? searchRes.note ?? 'Searching for these words (the model was not available):'}
                {(searchRes.word_hits ?? [])
                  .filter((h) => h.words.length)
                  .map((h) => (
                    <div key={h.fragment} className="word-hits">
                      <div className="counts">
                        Words in your chats containing “{h.fragment}”, rarest first (found before Nemotron read the question):
                      </div>
                      <div className="terms">
                        {h.words.map((w) => (
                          <button
                            key={w.word}
                            className="pill word-hit chip-toggle"
                            aria-pressed={chipSel.includes(w.word)}
                            title={`${w.messages} message${w.messages === 1 ? '' : 's'} · click to show only messages with it`}
                            onClick={() => void toggleChip(w.word)}
                          >
                            {w.word} <span className="counts">· {w.messages}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                {searchRes.terms.length ? (
                  <div className="terms">
                    {searchRes.terms.map((t) => (
                      <button key={t} className="pill chip-toggle" aria-pressed={chipSel.includes(t)} title="Click to show only messages with it" onClick={() => void toggleChip(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="counts chip-note">
                  {filtering ? (
                    <>
                      Showing only messages with: <strong>{chipSel.join(', ')}</strong> ·{' '}
                      <button
                        className="linklike"
                        onClick={() => {
                          chipGen.current++;
                          setChipSel([]);
                          setChipRes(null);
                        }}
                      >
                        Clear filter
                      </button>
                    </>
                  ) : (
                    'Click words above to show only the messages with them.'
                  )}
                </div>
              </div>
              {answer ? (
                <div className="bubble answer" aria-live="polite">
                  <div className="ask-label">Nemotron’s answer</div>
                  {answer.state === 'loading' ? (
                    <span className="counts">{answer.note ?? 'NVIDIA Nemotron is reading the chat’s discussion summaries and the matching messages to answer (up to a few minutes for a long chat)…'}</span>
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
                              {p.sources.map((src) => (
                                <button key={src.message_id} className="cite" title={`${src.sender}: ${src.snippet}`} onClick={() => onOpenMessage(src.chat_id, src.message_id)}>
                                  {/* Numbered across the answer: the same [n] always opens the same message. */}
                                  [{sourceNumbers(answer.answer.points.flatMap((x) => x.sources.map((y) => y.message_id))).get(src.message_id)}]
                                </button>
                              ))}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <span className="counts">
                        Answered by NVIDIA Nemotron
                        {answer.answer.read ? ` after reading ${answer.answer.read.discussions.toLocaleString('en-US')} discussion summaries and ${answer.answer.read.messages} matching messages` : ''}. Click [n] to open the original message.
                      </span>
                    </>
                  )}
                </div>
              ) : null}
              {!filtering && searchRes.topics.length ? <div className="ask-section">Topics · {searchRes.topics.length}</div> : null}
              {(filtering ? [] : searchRes.topics).map((t) => (
                <button key={t.topic_id} className="msg ask-topic" onClick={() => onRevealPath(t.chat_id, t.topic_id)}>
                  Topic: {t.path.map((p) => p.title).join(' › ')}
                </button>
              ))}
              {filtering && !chipRes ? <p className="counts">Filtering…</p> : null}
              {shownResults.length ? (
                <div className="ask-section">
                  From your chats ·{' '}
                  {listRes?.total && listRes.total > shownResults.length
                    ? `${shownResults.length} of ${listRes.total.toLocaleString('en-US')} messages`
                    : `${shownResults.length} message${shownResults.length === 1 ? '' : 's'}`}{' '}
                  {filtering ? `with ${chipSel.join(', ')} ` : ''}
                  · exact, then partial, then by meaning · double-click to open
                </div>
              ) : null}
              {shownResults.map((r, i) => (
                <div key={r.message_id}>
                {r.match && r.match !== shownResults[i - 1]?.match ? (
                  <div className="ask-tier">{{ exact: 'Exact match', partial: `Contains “${searchRes.query.trim()}” inside a word`, meaning: 'Related by meaning' }[r.match]}</div>
                ) : null}
                <div className="msg ask-hit" {...openOnDoubleClick(() => onOpenMessage(r.chat_id, r.message_id))}>
                  {r.context?.before ? (
                    <div className="ask-ctx">
                      ↑ {r.context.before.rel} · <strong>{r.context.before.sender}</strong>: {r.context.before.text}
                    </div>
                  ) : null}
                  <strong>{r.sender}</strong> <span className={r.review === 'missed' ? 'missed' : 'readbadge'}>{r.review}</span>
                  {r.match === 'exact' || (!r.match && r.exact) ? <span className="exact-badge">exact match</span> : r.match === 'partial' ? <span className="exact-badge partial">partial match</span> : null}
                  <div>{r.snippet}</div>
                  {r.context?.after ? (
                    <div className="ask-ctx">
                      ↓ {r.context.after.rel} · <strong>{r.context.after.sender}</strong>: {r.context.after.text}
                    </div>
                  ) : null}
                  <div className="path">{r.topic_paths.map((p) => p.map((x) => x.title).join(' › ')).join(' | ')}</div>
                </div>
                </div>
              ))}
              {nextOffset !== null ? (
                <div ref={moreRef} className="ask-more">
                  <button disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? 'Loading more…' : `Load more (${((listRes?.total ?? 0) - shownResults.length).toLocaleString('en-US')} left)`}
                  </button>
                </div>
              ) : null}
              {listRes && !shownResults.length && (filtering || !searchRes.topics.length) ? <p className="counts">{filtering ? 'No messages with these words.' : 'No matches under the current filters.'}</p> : null}
            </div>
          ) : selectedNode && chatId ? (
            <NodeDrawer
              chatId={chatId}
              nodeId={selectedNode}
              filter={viewFilter}
              refreshKey={refreshKey}
              onOpenMessage={onOpenMessage}
              onChanged={() => {
                void loadMap();
                void loadChats();
              }}
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
