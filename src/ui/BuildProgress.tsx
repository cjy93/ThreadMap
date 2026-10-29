'use client';
// How far the map is from showing every message: a progress bar with a time
// estimate while Nemotron works, or a note saying why the map is partial.
import { useEffect, useState } from 'react';

interface Props {
  chatKey: string;
  total: number;
  /** Messages not on the map yet. */
  pending: number;
  /** Analysis jobs queued or running. */
  jobs: number;
  /** Messages Nemotron has still to read in this build (queued or in a running batch). */
  unread: number;
  failed: boolean;
  budgetPaused: boolean;
  onRefresh?: () => void;
}

function eta(ms: number) {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'under a minute left' : min === 1 ? 'about 1 minute left' : `about ${min} minutes left`;
}

export function BuildProgress({ chatKey, total, pending, jobs, unread, failed, budgetPaused, onRefresh }: Props) {
  // Recent (time, messages left to read) readings for this chat; how fast they are read gives
  // the estimate. Counting messages, not jobs, covers the whole build: jobs exist only for the
  // batches made so far, and messages reach the map only at the end.
  const [samples, setSamples] = useState<{ key: string; list: { t: number; unread: number }[] }>({ key: chatKey, list: [] });
  useEffect(() => {
    const now = Date.now();
    setSamples((cur) => {
      const list = cur.key === chatKey ? [...cur.list] : [];
      if (list.length && list[list.length - 1].unread === unread) return cur.key === chatKey ? cur : { key: chatKey, list };
      // More to read (new history arrived, or a new run) starts a fresh estimate.
      if (list.length && unread > list[list.length - 1].unread) list.length = 0;
      list.push({ t: now, unread });
      while (list.length > 2 && now - list[0].t > 5 * 60_000) list.shift();
      return { key: chatKey, list };
    });
  }, [chatKey, unread]);
  const list = samples.key === chatKey ? samples.list : [];
  // Click to fold the box into a small pill (and back); remembered on this browser.
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('tm-progress-folded') === '1') setFolded(true);
    } catch {
      // Storage blocked: start unfolded.
    }
  }, []);
  const toggle = () =>
    setFolded((f) => {
      try {
        window.localStorage.setItem('tm-progress-folded', f ? '0' : '1');
      } catch {
        // Storage blocked: the toggle still works for this visit.
      }
      return !f;
    });

  if (jobs > 0) {
    const reading = unread > 0;
    const read = Math.max(0, total - unread);
    const pct = total ? Math.round((read / total) * 100) : 0;
    let note = 'all messages read · laying out the topics';
    if (reading) {
      note = 'estimating time left…';
      if (list.length >= 2) {
        const first = list[0];
        const last = list[list.length - 1];
        const rate = (first.unread - last.unread) / (last.t - first.t); // messages per ms
        if (rate > 0) note = `${eta(last.unread / rate)} to read them all, then the topics are laid out`;
      }
    }
    if (folded) {
      return (
        <button className="build-progress folded" onClick={toggle} aria-expanded={false} title="Show map building progress">
          ▸ Building the map · {reading ? `${pct}% read` : 'laying out topics'}
          <span className="bp-bar" aria-hidden>
            <span style={{ width: `${reading ? pct : 100}%` }} className={reading ? undefined : 'busy'} />
          </span>
        </button>
      );
    }
    return (
      <div className="build-progress" role="status" aria-live="polite" onClick={toggle} title="Click to hide">
        <div className="bp-text">
          <strong>Building the map:</strong> {read.toLocaleString('en-US')} of {total.toLocaleString('en-US')} messages read · {note}
        </div>
        <div className="bp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading ? pct : 100} aria-label="Messages read by Nemotron">
          <span style={{ width: `${reading ? pct : 100}%` }} className={reading ? undefined : 'busy'} />
        </div>
        <div className="bp-sub">
          The first build is the slowest: Nemotron reads every message in batches, then lays out the topics, and the messages appear on the map once that is done. After that, Refresh only reads new messages, and Re-read chat reads every message again.
        </div>
      </div>
    );
  }
  if (pending > 0) {
    const why = budgetPaused
      ? 'Analysis paused: one step used up its share of model calls. Click Refresh to carry on.'
      : failed
        ? 'The last analysis step failed before it finished.'
        : 'They arrived after the last analysis — Nemotron only runs when you open a chat or click Refresh.';
    if (folded) {
      return (
        <button className="build-progress folded partial" onClick={toggle} aria-expanded={false} title="Show why the map is partial">
          ▸ Partial map · {pending.toLocaleString('en-US')} not placed
        </button>
      );
    }
    return (
      <div className="build-progress partial" role="status" onClick={toggle} title="Click to hide">
        <div className="bp-text">
          <strong>Partial map:</strong> {pending.toLocaleString('en-US')} of {total.toLocaleString('en-US')} messages are not on the map yet. {why}
        </div>
        {onRefresh ? (
          <button
            className="primary"
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
          >
            Refresh to add them
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}
