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
  failed: boolean;
  budgetPaused: boolean;
  onRefresh?: () => void;
}

function eta(ms: number) {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'under a minute left' : min === 1 ? 'about 1 minute left' : `about ${min} minutes left`;
}

export function BuildProgress({ chatKey, total, pending, jobs, failed, budgetPaused, onRefresh }: Props) {
  // Recent (time, jobs left) readings for this chat; how fast jobs finish gives the estimate
  // (messages only reach the map at the end of a build, so their count is a poor clock).
  const [samples, setSamples] = useState<{ key: string; list: { t: number; jobs: number }[] }>({ key: chatKey, list: [] });
  useEffect(() => {
    const now = Date.now();
    setSamples((cur) => {
      const list = cur.key === chatKey ? [...cur.list] : [];
      if (list.length && list[list.length - 1].jobs === jobs) return cur.key === chatKey ? cur : { key: chatKey, list };
      // A new run (jobs went up) starts a fresh estimate.
      if (list.length && jobs > list[list.length - 1].jobs) list.length = 0;
      list.push({ t: now, jobs });
      while (list.length > 2 && now - list[0].t > 5 * 60_000) list.shift();
      return { key: chatKey, list };
    });
  }, [chatKey, jobs]);
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
    const placed = Math.max(0, total - pending);
    const pct = total ? Math.round((placed / total) * 100) : 0;
    let note = 'estimating time left…';
    if (pending === 0) note = 'adding deeper topics and grouping related ones';
    else if (list.length >= 2) {
      const first = list[0];
      const last = list[list.length - 1];
      const rate = (first.jobs - last.jobs) / (last.t - first.t); // jobs per ms
      // Plus a little for laying out the topics once reading is done.
      if (rate > 0) note = eta(last.jobs / rate + 60_000);
    }
    if (folded) {
      return (
        <button className="build-progress folded" onClick={toggle} aria-expanded={false} title="Show map building progress">
          ▸ Building the map · {pending === 0 ? 'grouping' : `${pct}%`}
          <span className="bp-bar" aria-hidden>
            <span style={{ width: `${pending === 0 ? 100 : pct}%` }} className={pending === 0 ? 'busy' : undefined} />
          </span>
        </button>
      );
    }
    return (
      <div className="build-progress" role="status" aria-live="polite" onClick={toggle} title="Click to hide">
        <div className="bp-text">
          <strong>Building the map:</strong> {placed.toLocaleString('en-US')} of {total.toLocaleString('en-US')} messages placed · {note}
        </div>
        <div className="bp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Messages placed on the map">
          <span style={{ width: `${pending === 0 ? 100 : pct}%` }} className={pending === 0 ? 'busy' : undefined} />
        </div>
        <div className="bp-sub">Nemotron first reads every message in batches, then lays out the topics, so the bar can stay still for a while before jumping.</div>
      </div>
    );
  }
  if (pending > 0) {
    const why = budgetPaused
      ? 'Analysis paused because the daily model budget was reached.'
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
        {onRefresh && !budgetPaused ? (
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
