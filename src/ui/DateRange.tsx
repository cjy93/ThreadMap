'use client';
// The map's date filter as a slider: two handles over the days this chat has messages
// (so a range can never miss the chat), a bar per day showing how busy it was, and a label
// with the chosen dates and how many messages they hold. Each handle sits exactly at the
// centre of its day's bar. With many days, Zoom shows a few weeks around the handle last
// moved, with ‹ › to pan. Enter applies the range.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** "2026-10-09" -> "9 Oct 2026" (already a local calendar day). */
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Above this many days the bars get thin: offer Zoom. */
const ZOOM_FROM = 40;
/** Days shown when zoomed in. */
const ZOOM_DAYS = 30;

type Handle = 'lo' | 'hi';

export function DateRange({
  days,
  from,
  to,
  applied,
  changed,
  onPick,
  onApply,
  onClear,
}: {
  /** Days with messages, oldest first. */
  days: { day: string; n: number }[];
  from?: string;
  to?: string;
  /** A range is applied to the map now. */
  applied: boolean;
  /** The handles differ from what the map shows. */
  changed: boolean;
  onPick: (from: string | undefined, to: string | undefined) => void;
  onApply: () => void;
  onClear: () => void;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(false);
  // First day shown when zoomed in; null follows the handle last moved.
  const [viewStart, setViewStart] = useState<number | null>(null);
  const [active, setActive] = useState<Handle>('hi');
  const [drag, setDrag] = useState<Handle | null>(null);

  if (!days.length) {
    return (
      <div className="datebox daterange">
        <span className="counts">No dated messages yet</span>
      </div>
    );
  }
  const last = days.length - 1;
  // Each handle sits on the first (or last) day with messages inside the picked range.
  let lo = from ? days.findIndex((d) => d.day >= from) : 0;
  let hi = to ? days.findLastIndex((d) => d.day <= to) : last;
  if (lo < 0) lo = last;
  if (hi < 0) hi = 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  const total = days.reduce((a, d) => a + d.n, 0);
  const inRange = days.slice(lo, hi + 1).reduce((a, d) => a + d.n, 0);

  // The days on screen: all of them, or a window of ZOOM_DAYS when zoomed in.
  const canZoom = days.length > ZOOM_FROM;
  const zoomed = canZoom && zoom;
  const count = zoomed ? ZOOM_DAYS : days.length;
  const centre = active === 'lo' ? lo : hi;
  const start = zoomed ? Math.max(0, Math.min(days.length - count, viewStart ?? centre - Math.floor(count / 2))) : 0;
  const shown = days.slice(start, start + count);
  const max = Math.max(...shown.map((d) => d.n));
  /** Left edge of day i (as a % of the track) and its centre: handles sit on bar centres. */
  const centreOf = (i: number) => ((i - start + 0.5) / count) * 100;

  // Picking the full span means "all dates".
  const pick = (a: number, b: number) => onPick(a === 0 && b === last ? undefined : days[a].day, a === 0 && b === last ? undefined : days[b].day);
  const move = (h: Handle, i: number) => {
    const at = Math.max(0, Math.min(last, i));
    setActive(h);
    if (h === 'lo') pick(Math.min(at, hi), hi);
    else pick(lo, Math.max(at, lo));
  };
  /** The day under a pointer position on the track. */
  const dayAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !r.width) return start;
    return start + Math.max(0, Math.min(count - 1, Math.floor(((clientX - r.left) / r.width) * count)));
  };
  const onTrackDown = (e: ReactPointerEvent) => {
    // A click on the track moves the nearer handle there, then drags it.
    const i = dayAt(e.clientX);
    const h: Handle = Math.abs(i - lo) <= Math.abs(i - hi) && !(i > hi) ? 'lo' : 'hi';
    move(h, i);
    setDrag(h);
    track.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (drag) move(drag, dayAt(e.clientX));
  };
  const onUp = (e: ReactPointerEvent) => {
    setDrag(null);
    if (track.current?.hasPointerCapture(e.pointerId)) track.current.releasePointerCapture(e.pointerId);
  };
  const keys = (h: Handle) => (e: React.KeyboardEvent) => {
    const at = h === 'lo' ? lo : hi;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -7, PageUp: 7 };
    if (e.key in step) move(h, at + step[e.key]);
    else if (e.key === 'Home') move(h, 0);
    else if (e.key === 'End') move(h, last);
    else return;
    e.preventDefault();
    setViewStart(null);
  };
  const handle = (h: Handle) => {
    const i = h === 'lo' ? lo : hi;
    const visible = i >= start && i < start + count;
    return (
      <span
        key={h}
        role="slider"
        tabIndex={0}
        aria-label={h === 'lo' ? 'From' : 'To'}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={i}
        aria-valuetext={fmtDay(days[i].day)}
        className={`dr-thumb ${visible ? '' : 'dr-off'} ${active === h ? 'dr-active' : ''}`}
        // Off screen (zoomed in): pinned to the edge it lies beyond.
        style={{ left: `${visible ? centreOf(i) : i < start ? 0 : 100}%` }}
        onKeyDown={keys(h)}
        onPointerDown={(e) => {
          e.stopPropagation();
          setActive(h);
          setDrag(h);
          track.current?.setPointerCapture(e.pointerId);
        }}
        title={fmtDay(days[i].day)}
      />
    );
  };

  return (
    <form
      className="datebox daterange"
      role="group"
      aria-label="Date range"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      {zoomed ? (
        <button type="button" className="dr-pan" aria-label="Earlier days" disabled={start === 0} onClick={() => setViewStart(Math.max(0, start - Math.floor(count / 2)))}>
          ‹
        </button>
      ) : null}
      <div className="dr-body">
        <div className="dr-track" ref={track} onPointerDown={onTrackDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="dr-bars" aria-hidden>
            {shown.map((d, k) => (
              <span
                key={d.day}
                className={start + k >= lo && start + k <= hi ? 'on' : undefined}
                style={{ height: `${Math.max(12, Math.round((d.n / max) * 100))}%` }}
                title={`${fmtDay(d.day)} · ${d.n} message${d.n === 1 ? '' : 's'}`}
              />
            ))}
          </div>
          <div className="dr-rail" aria-hidden>
            <span style={{ left: `${Math.max(0, Math.min(100, centreOf(lo)))}%`, right: `${100 - Math.max(0, Math.min(100, centreOf(hi)))}%` }} />
          </div>
          {handle('lo')}
          {handle('hi')}
        </div>
        <div className="dr-label" aria-live="polite">
          {fmtDay(days[lo].day)} → {fmtDay(days[hi].day)} · {inRange.toLocaleString('en-US')} of {total.toLocaleString('en-US')} messages
          {zoomed ? ` · showing ${fmtDay(shown[0].day)} – ${fmtDay(shown[shown.length - 1].day)}` : ''}
        </div>
      </div>
      {zoomed ? (
        <button type="button" className="dr-pan" aria-label="Later days" disabled={start + count >= days.length} onClick={() => setViewStart(Math.min(days.length - count, start + Math.floor(count / 2)))}>
          ›
        </button>
      ) : null}
      {canZoom ? (
        <button
          type="button"
          aria-pressed={zoomed}
          title={zoomed ? 'Show all days' : `Zoom in: ${ZOOM_DAYS} days around the handle you last moved`}
          onClick={() => {
            setZoom(!zoom);
            setViewStart(null);
          }}
        >
          {zoomed ? 'All days' : 'Zoom'}
        </button>
      ) : null}
      <button type="submit" className={changed ? 'primary' : undefined} title="Show only messages between these dates">
        Enter
      </button>
      {applied ? (
        <button type="button" title="Show all dates" onClick={onClear}>
          Clear
        </button>
      ) : null}
    </form>
  );
}
