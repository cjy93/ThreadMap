'use client';
// The map's date filter as a slider: two handles over the days this chat has messages
// (so a range can never miss the chat), a bar per day showing how busy it was, and a label
// with the chosen dates and how many messages they hold. Enter applies the range.

/** "2026-10-09" -> "9 Oct 2026" (already a local calendar day). */
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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
  const max = Math.max(...days.map((d) => d.n));
  // Picking the full span means "all dates".
  const pick = (a: number, b: number) => onPick(a === 0 && b === last ? undefined : days[a].day, a === 0 && b === last ? undefined : days[b].day);
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
      <div className="dr-body">
        <div className="dr-track">
          <div className="dr-bars" aria-hidden>
            {days.map((d, i) => (
              <span key={d.day} className={i >= lo && i <= hi ? 'on' : undefined} style={{ height: `${Math.max(12, Math.round((d.n / max) * 100))}%` }} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={last}
            value={lo}
            aria-label="From"
            aria-valuetext={fmtDay(days[lo].day)}
            onChange={(e) => pick(Math.min(Number(e.target.value), hi), hi)}
          />
          <input
            type="range"
            min={0}
            max={last}
            value={hi}
            aria-label="To"
            aria-valuetext={fmtDay(days[hi].day)}
            onChange={(e) => pick(lo, Math.max(Number(e.target.value), lo))}
          />
        </div>
        <div className="dr-label" aria-live="polite">
          {fmtDay(days[lo].day)} → {fmtDay(days[hi].day)} · {inRange.toLocaleString('en-US')} of {total.toLocaleString('en-US')} messages
        </div>
      </div>
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
