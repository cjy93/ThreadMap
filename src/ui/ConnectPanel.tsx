'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { api, leaveAndDeleteAccount } from './client';

interface Status {
  mode: 'private' | 'demo';
  pairing_allowed: boolean;
  desired_state?: string;
  connection: { state: string; detail: string | null; last_event_at?: string | null; heartbeat_at?: string | null; uncertain_intervals?: { from: string; to: string }[]; relink_required?: boolean; remote_unlink_confirmed?: boolean | null };
  companion_heartbeat_at?: string | null;
  history?: { chat_id: string; title: string; history_state: string; earliest_at: string | null; latest_at: string | null; history_count: number; live_count: number }[];
  analysis?: { pending: number; budget_paused: number; failed: number; undispatched: number };
}
interface Discovered {
  id: string;
  title: string;
  kind: string;
  selected: boolean;
  phone: string | null;
  last_message_at: string | null;
  avatar_url: string | null;
  /** The profile photo has not been looked up recently; ask once the row is on screen. */
  avatar_due: boolean;
}

const AVATAR_REQUEST_BATCH = 40;

const LINKED = ['connected', 'reconnecting', 'paused'];
const CAN_PAIR = ['disconnected', 'relink_required', 'error'];
const POLL_MS = 3000;

/** Last-message time as WhatsApp lists it: time today, "Yesterday", weekday this week, else the date. */
function lastMessageLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (d >= startOfToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const daysAgo = Math.ceil((startOfToday.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo <= 1) return 'Yesterday';
  if (daysAgo < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString();
}

/** Owner-only WhatsApp pairing, selection and lifecycle controls. */
export function ConnectPanel({
  refreshKey,
  qrTick,
  onClose,
  onOpenChat,
  onLinked,
}: {
  refreshKey: number;
  qrTick: number;
  onClose: () => void;
  onOpenChat: (chatId: string) => void;
  /** A scan just completed; the session may now belong to an existing account. */
  onLinked: () => void;
}) {
  const [st, setSt] = useState<Status | null>(null);
  const [chats, setChats] = useState<Discovered[]>([]);
  // The chat whose first open is being set up (storage, history, analysis).
  const [opening, setOpening] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | 'group' | 'direct'>('all');
  // Profile photos are requested only for rows that scroll into view, in small batches.
  const askedAvatars = useRef(new Set<string>());
  const avatarQueue = useRef(new Set<string>());
  const avatarTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [avatarObserver, setAvatarObserver] = useState<IntersectionObserver | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const flush = () => {
      const ids = [...avatarQueue.current];
      avatarQueue.current.clear();
      for (let i = 0; i < ids.length; i += AVATAR_REQUEST_BATCH) {
        void api('/api/whatsapp/avatars', { method: 'POST', json: { chat_ids: ids.slice(i, i + AVATAR_REQUEST_BATCH) } }).catch(() => undefined);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.chatId;
        if (!e.isIntersecting || !id || askedAvatars.current.has(id)) continue;
        askedAvatars.current.add(id);
        avatarQueue.current.add(id);
      }
      clearTimeout(avatarTimer.current);
      avatarTimer.current = setTimeout(flush, 400);
    });
    setAvatarObserver(observer);
    return () => {
      observer.disconnect();
      clearTimeout(avatarTimer.current);
    };
  }, []);
  const watchAvatar = useCallback(
    (el: HTMLTableRowElement | null) => {
      if (el && avatarObserver) avatarObserver.observe(el);
    },
    [avatarObserver],
  );
  const [qr, setQr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  // Linking by phone number instead of scanning: the number typed, and the code WhatsApp returned.
  const [phoneMode, setPhoneMode] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    const s = await api<Status>('/api/whatsapp/status');
    setSt(s);
    if (s.mode === 'private') {
      const c = await api<{ chats: Discovered[] }>('/api/whatsapp/chats').catch(() => ({ chats: [] }));
      setChats(c.chats);
    }
  }, []);
  const loadQr = useCallback(async () => {
    const r = await api<{ available: boolean; image?: string; code?: string | null }>('/api/whatsapp/qr').catch(() => ({ available: false }) as { available: boolean; image?: string; code?: string | null });
    setQr(r.available ? (r.image ?? null) : null);
    setCode(r.code ?? null);
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (st?.mode === 'private') void loadQr();
  }, [loadQr, qrTick, st?.mode, st?.connection.state]);

  const state = st?.connection.state ?? 'disconnected';
  const linked = LINKED.includes(state);
  const waitingForQr = !linked && (requested || state === 'pairing' || state === 'connecting');
  const waitingForChats = linked && !chats.length;
  // Live notices drive updates; polling covers a missed notice while the owner is mid-setup.
  useEffect(() => {
    if (!waitingForQr && !waitingForChats) return;
    const t = setInterval(() => {
      void load();
      if (waitingForQr) void loadQr();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waitingForQr, waitingForChats, load, loadQr]);
  // A pairing attempt that ends without a scan (QR expired) returns to a pairable state.
  const prevState = useRef(state);
  useEffect(() => {
    const was = prevState.current;
    prevState.current = state;
    if (linked) {
      setRequested(false);
      if (was === 'pairing' || was === 'connecting') onLinked();
    } else if ((was === 'pairing' || was === 'connecting') && CAN_PAIR.includes(state)) {
      setRequested(false);
      setMsg('The QR code expired before it was scanned. Show a new one to try again.');
    }
  }, [state, linked, onLinked]);

  if (!st) return <p>Loading connection…</p>;
  if (st.mode === 'demo') {
    return (
      <div className="card">
        <h3>Public demo</h3>
        <p>This workspace is an isolated synthetic replay. Pairing WhatsApp is disabled for demo guests and no private data is reachable.</p>
        <button onClick={onClose}>Close</button>
      </div>
    );
  }
  const act = async (path: string, label: string) => {
    setMsg(null);
    const r = await api<{ note?: string }>(path, { method: 'POST' }).catch((e: Error) => ({ note: e.message }));
    setMsg(r.note ?? `${label} requested`);
    void load();
  };
  const pair = async () => {
    setRequested(true);
    setQr(null);
    await act('/api/whatsapp/pair', 'Pairing');
  };
  // No camera: WhatsApp can link by an 8-character code typed on the phone.
  const pairWithPhone = async () => {
    setMsg(null);
    try {
      await api('/api/whatsapp/pair', { method: 'POST', json: { phone } });
      setRequested(true);
      setQr(null);
      setCode(null);
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not request a code.');
    }
  };
  // Opening a chat is the choice: the first open starts storing it, fetches its
  // history and queues NVIDIA Nemotron analysis, then shows its map as it fills.
  const open = async (ch: Discovered) => {
    if (!ch.selected) {
      setOpening(ch.id);
      try {
        await api('/api/whatsapp/selections', { method: 'PUT', json: { selections: [{ chat_id: ch.id, selected: true }] } });
      } catch (e) {
        setOpening(null);
        setMsg(e instanceof Error ? e.message : 'Could not open this chat.');
        return;
      }
    }
    onOpenChat(ch.id);
  };
  const c = st.connection;
  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const matches = (ch: Discovered) => !q || ch.title.toLowerCase().includes(q) || (qDigits.length >= 3 && Boolean(ch.phone?.includes(qDigits)));
  const shown = chats.filter((ch) => (kind === 'all' || ch.kind === kind) && matches(ch));
  const counts = { all: chats.length, group: chats.filter((ch) => ch.kind === 'group').length, direct: chats.filter((ch) => ch.kind === 'direct').length };
  const openedCount = chats.filter((ch) => ch.selected).length;
  return (
    <div className="card" style={{ maxWidth: 720, margin: '16px auto' }}>
      <h2 style={{ marginTop: 0 }}>Connect WhatsApp</h2>
      <p className="counts">
        ThreadMap runs a linked-device session in its cloud deployment (Nebius). Chats you open are stored in the deployment&apos;s database and their text is sent to
        Nebius Token Factory (NVIDIA Nemotron) for analysis. This uses Baileys, an unofficial WhatsApp Web library — an experimental integration that WhatsApp could restrict.
        Messages of chats you have not opened are held only briefly in memory (≤32 MiB, ≤5 min), then discarded; only their name, type, last-message time and the small
        profile photo of chats you scroll past are kept so this list can show them. ThreadMap never sends messages or read receipts.
      </p>

      <section>
        <h3>1. Scan the QR code</h3>
        <p>
          <strong>Connection:</strong> <span className="pill">{c.state}</span> {c.detail ? <span className="counts">{c.detail}</span> : null}
          <br />
          <span className="counts">
            Last event: {c.last_event_at ?? '—'} · companion heartbeat: {st.companion_heartbeat_at ?? '—'}
            {c.uncertain_intervals?.length ? ` · ${c.uncertain_intervals.length} possible gap(s) in coverage` : ''}
          </span>
        </p>
        {linked ? <p role="status">WhatsApp is linked. Choose chats below.</p> : null}
        {!linked && st.pairing_allowed && CAN_PAIR.includes(state) && !requested ? (
          <>
            {chats.length ? (
              <p className="counts" role="note">
                Scanning starts from scratch: the {chats.length} chats below, their messages and maps are deleted once the new scan succeeds.
              </p>
            ) : null}
            <button className="primary" onClick={pair}>
              Show QR code
            </button>
          </>
        ) : null}
        {!st.pairing_allowed && !linked ? <p className="counts">Pairing is disabled on this deployment (WHATSAPP_PAIRING_ENABLED=false).</p> : null}
        {!linked && st.pairing_allowed ? (
          <p>
            <button className="linklike" onClick={() => setPhoneMode(!phoneMode)}>
              {phoneMode ? 'Use a QR code instead' : "Can't scan? Link with phone number"}
            </button>
          </p>
        ) : null}
        {!linked && phoneMode ? (
          <div className="phone-link">
            <label>
              WhatsApp number with country code
              <input type="tel" inputMode="tel" placeholder="65 9123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <button className="primary" disabled={phone.replace(/\D/g, '').length < 8} onClick={() => void pairWithPhone()}>
              Get code
            </button>
            {code ? (
              <>
                <div className="pair-code" aria-label="Pairing code">
                  {code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code}
                </div>
                <p className="counts">
                  On your phone: WhatsApp → Settings → Linked Devices → Link a device → <strong>Link with phone number instead</strong>, then type this code
                  within about 2 minutes. If it expires, click Get code again for a new one.
                </p>
              </>
            ) : requested ? (
              <p className="counts" role="status">Requesting a code from WhatsApp…</p>
            ) : null}
          </div>
        ) : null}
        {waitingForQr && !phoneMode ? (
          <div>
            <p>On your phone, open WhatsApp → Settings → Linked Devices → Link a device, and scan this code with WhatsApp&apos;s own scanner (not the camera app). It refreshes automatically.</p>
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="WhatsApp pairing QR code (owner only)" width={280} height={280} />
            ) : (
              <div role="status" aria-live="polite" style={{ width: 280, height: 280, display: 'grid', placeItems: 'center', border: '1px dashed var(--border-strong)', borderRadius: 12 }}>
                <span className="counts">Generating QR code…</span>
              </div>
            )}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {c.state === 'connected' || c.state === 'reconnecting' ? <button onClick={() => act('/api/whatsapp/pause', 'Pause')}>Pause sync</button> : null}
          {c.state === 'paused' ? <button onClick={() => act('/api/whatsapp/resume', 'Resume')}>Resume sync</button> : null}
          {linked || chats.length ? (
            <button className="danger" onClick={() => void leaveAndDeleteAccount()}>
              Disconnect &amp; delete my data
            </button>
          ) : c.state !== 'disconnected' || requested ? (
            <button
              className="danger"
              onClick={() => {
                setRequested(false);
                void act('/api/whatsapp/disconnect', 'Disconnect');
              }}
            >
              Cancel pairing
            </button>
          ) : null}
        </div>
        {c.remote_unlink_confirmed === false && !linked ? <p className="counts">Remote unlink not confirmed: remove “ThreadMap” in WhatsApp → Linked Devices.</p> : null}
        {msg ? <p role="status">{msg}</p> : null}
      </section>

      <section>
        <h3>2. Choose chats</h3>
        {!chats.length ? (
          <p className="counts">
            {linked ? 'Waiting for WhatsApp to send your chat list… this can take a minute after linking.' : 'Your WhatsApp chats appear here after you scan the code.'}
          </p>
        ) : (
          <>
            <p className="counts">
              Click Open on a chat to see its map. The first time you open a chat, ThreadMap starts storing its messages, fetches its recent history from your phone and
              analyses it with NVIDIA Nemotron; chats you never open are not stored or analysed. {openedCount} of {chats.length} opened.
            </p>
            {/* Stays in view while scrolling a long chat list. */}
            <div className="chat-toolbar">
              <div className="seg" role="group" aria-label="Chat type">
                {(['all', 'group', 'direct'] as const).map((k) => (
                  <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                    {k === 'all' ? 'All' : k === 'group' ? 'Groups' : 'People'} ({counts[k]})
                  </button>
                ))}
              </div>
              <input type="search" placeholder="Search by name or number" aria-label="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Chat</th>
                  <th align="left">Type</th>
                  <th align="left">Last message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((ch) => {
                  return (
                    <tr key={ch.id} data-chat-id={ch.id} ref={ch.avatar_due ? watchAvatar : undefined}>
                      <td>
                        <div className="chat-name">
                          <Avatar title={ch.title} url={ch.avatar_url} />
                          <div>
                            {ch.title} {ch.selected ? <span className="pill">Opened</span> : null}
                            {/* The number helps tell people apart; never shown where WhatsApp masked it. */}
                            {ch.phone && ch.phone !== ch.title && !/[∙•·]/.test(ch.title) ? <div className="counts">{ch.phone}</div> : null}
                          </div>
                        </div>
                      </td>
                      <td className="counts">{ch.kind === 'group' ? 'Group' : 'Person'}</td>
                      <td className="counts">{lastMessageLabel(ch.last_message_at)}</td>
                      <td align="right">
                        <button aria-label={`Open ${ch.title}`} disabled={opening !== null} onClick={() => void open(ch)}>
                          {opening === ch.id ? 'Opening…' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!shown.length ? (
                  <tr>
                    <td colSpan={4} className="counts">
                      {q ? `No chats match “${search}”.` : 'No chats of this type yet.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </>
        )}
      </section>

      {st.history?.length ? (
        <section>
          <h3>Coverage (observed, not a completeness guarantee)</h3>
          {st.history.map((h) => (
            <div key={h.chat_id} className="counts" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
              <span>
                {h.title}: {h.history_count + h.live_count} messages · range {h.earliest_at?.slice(0, 10) ?? '—'} → {h.latest_at?.slice(0, 10) ?? '—'}
              </span>
            </div>
          ))}
          <div className="counts">
            Analysis backlog: {st.analysis?.pending ?? 0} jobs, {st.analysis?.undispatched ?? 0} messages queued{st.analysis?.budget_paused ? ` · ${st.analysis.budget_paused} paused by budget` : ''}
            {st.analysis?.failed ? ` · ${st.analysis.failed} failed` : ''}
          </div>
        </section>
      ) : null}
      <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={onClose}>Back to maps</button>
        {/* Home without signing out: signing out deletes this account's data. */}
        <a href="/?home=1">
          <button>Home page</button>
        </a>
      </p>
    </div>
  );
}
