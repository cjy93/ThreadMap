'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from './client';

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
  historyMode: 'available_history' | 'new_only';
  cutoff: string | null;
}

/** Owner-only WhatsApp pairing, selection and lifecycle controls. */
export function ConnectPanel({ refreshKey, qrTick, onClose }: { refreshKey: number; qrTick: number; onClose: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [chats, setChats] = useState<Discovered[]>([]);
  const [draft, setDraft] = useState<Record<string, { selected: boolean; mode: Discovered['historyMode'] }>>({});
  const [qr, setQr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await api<Status>('/api/whatsapp/status');
    setSt(s);
    if (s.mode === 'private') {
      const c = await api<{ chats: Discovered[] }>('/api/whatsapp/chats').catch(() => ({ chats: [] }));
      setChats(c.chats);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (st?.mode !== 'private') return;
    api<{ available: boolean; image?: string }>('/api/whatsapp/qr').then((r) => setQr(r.available ? (r.image ?? null) : null), () => setQr(null));
  }, [qrTick, st?.mode, st?.connection.state]);

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
  const save = async () => {
    const selections = Object.entries(draft).map(([chat_id, d]) => ({ chat_id, selected: d.selected, history_mode: d.mode }));
    await api('/api/whatsapp/selections', { method: 'PUT', json: { selections } });
    setDraft({});
    setMsg('Selection saved. Only selected chats are stored and analysed.');
    void load();
  };
  const c = st.connection;
  return (
    <div className="card" style={{ maxWidth: 720, margin: '16px auto' }}>
      <h2 style={{ marginTop: 0 }}>WhatsApp connection</h2>
      <p className="counts">
        ThreadMap runs a linked-device session in its cloud deployment (Nebius). Selected chats are stored in the deployment&apos;s database and selected text is sent to
        Nebius Token Factory (NVIDIA Nemotron) for analysis. This uses Baileys, an unofficial WhatsApp Web library — an experimental integration that WhatsApp could restrict.
        Unselected chats are held only briefly in memory (≤32 MiB, ≤5 min) while you choose, then discarded. ThreadMap never sends messages or read receipts.
      </p>
      <p>
        <strong>Connection:</strong> <span className="pill">{c.state}</span> {c.detail ? <span className="counts">{c.detail}</span> : null}
        <br />
        <span className="counts">
          Last event: {c.last_event_at ?? '—'} · companion heartbeat: {st.companion_heartbeat_at ?? '—'}
          {c.uncertain_intervals?.length ? ` · ${c.uncertain_intervals.length} possible gap(s) in coverage` : ''}
        </span>
      </p>
      {qr ? (
        <div>
          <p>Scan in WhatsApp → Settings → Linked Devices → Link a device. The code refreshes automatically.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="WhatsApp pairing QR code (owner only)" width={280} height={280} />
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {st.pairing_allowed && (c.state === 'disconnected' || c.state === 'relink_required' || c.state === 'error') ? (
          <button className="primary" onClick={() => act('/api/whatsapp/pair', 'Pairing')}>
            Connect WhatsApp
          </button>
        ) : null}
        {c.state === 'connected' || c.state === 'reconnecting' ? <button onClick={() => act('/api/whatsapp/pause', 'Pause')}>Pause sync</button> : null}
        {c.state === 'paused' ? <button onClick={() => act('/api/whatsapp/resume', 'Resume')}>Resume sync</button> : null}
        {c.state !== 'disconnected' ? (
          <button className="danger" onClick={() => act('/api/whatsapp/disconnect', 'Disconnect')}>
            Disconnect &amp; remove session
          </button>
        ) : null}
      </div>
      {c.remote_unlink_confirmed === false ? <p className="counts">Remote unlink not confirmed: remove “ThreadMap” in WhatsApp → Linked Devices.</p> : null}
      {msg ? <p role="status">{msg}</p> : null}
      {chats.length ? (
        <section>
          <h3>Choose chats</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">Chat</th>
                <th>Select</th>
                <th align="left">History</th>
              </tr>
            </thead>
            <tbody>
              {chats.map((ch) => {
                const d = draft[ch.id] ?? { selected: ch.selected, mode: ch.historyMode };
                return (
                  <tr key={ch.id}>
                    <td>
                      {ch.title} <span className="counts">{ch.kind}</span>
                    </td>
                    <td align="center">
                      <input type="checkbox" aria-label={`Select ${ch.title}`} checked={d.selected} onChange={(e) => setDraft({ ...draft, [ch.id]: { ...d, selected: e.target.checked } })} />
                    </td>
                    <td>
                      <select value={d.mode} onChange={(e) => setDraft({ ...draft, [ch.id]: { ...d, mode: e.target.value as Discovered['historyMode'] } })} aria-label={`History mode for ${ch.title}`}>
                        <option value="available_history">Available history + new messages</option>
                        <option value="new_only">New messages from now</option>
                      </select>
                      {ch.cutoff ? <span className="counts"> from {new Date(ch.cutoff).toLocaleString()}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="primary" disabled={!Object.keys(draft).length} onClick={save}>
            Save selection
          </button>
        </section>
      ) : null}
      {st.history?.length ? (
        <section>
          <h3>Coverage (observed, not a completeness guarantee)</h3>
          {st.history.map((h) => (
            <div key={h.chat_id} className="counts">
              {h.title}: {h.history_state} · history {h.history_count} · live {h.live_count} · range {h.earliest_at?.slice(0, 10) ?? '—'} → {h.latest_at?.slice(0, 10) ?? '—'}
            </div>
          ))}
          <div className="counts">
            Analysis backlog: {st.analysis?.pending ?? 0} jobs, {st.analysis?.undispatched ?? 0} messages queued{st.analysis?.budget_paused ? ` · ${st.analysis.budget_paused} paused by budget` : ''}
            {st.analysis?.failed ? ` · ${st.analysis.failed} failed` : ''}
          </div>
        </section>
      ) : null}
      <p>
        <button onClick={onClose}>Back to maps</button>
      </p>
    </div>
  );
}
