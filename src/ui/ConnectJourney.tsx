'use client';
// The Connect page as a short journey: numbered steps along a glowing line, each with a
// line-art drawing that draws itself in when the step scrolls into view. Our own SVG and
// CSS (globals.css "Connect journey"); motion is off for prefers-reduced-motion.
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** True once the element has been on screen (stays true: the drawing does not redraw). */
function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (very old browser): show the drawings at once, on the next frame.
      const id = requestAnimationFrame(() => setSeen(true));
      return () => cancelAnimationFrame(id);
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/**
 * One step: its words on one side of the line, its picture (or live control) on the other,
 * alternating sides; `wide` content (the chat list) spans the whole width below.
 */
export function JourneyStep({
  n,
  kicker,
  title,
  state,
  side,
  visual,
  wide,
  children,
}: {
  n: number;
  kicker: string;
  title: string;
  /** done: finished; now: the step to do next (its dot glows); later: not yet. */
  state: 'done' | 'now' | 'later';
  side: 'left' | 'right';
  visual: ReactNode;
  wide?: ReactNode;
  children?: ReactNode;
}) {
  const [ref, seen] = useInView<HTMLLIElement>();
  return (
    <li ref={ref} className={`jstep jstep-${side} jstep-${state} ${seen ? 'in' : ''}`} aria-current={state === 'now' ? 'step' : undefined}>
      <div className="jtext">
        <div className="jkicker">
          {String(n).padStart(2, '0')} · {kicker}
        </div>
        <h3>{title}</h3>
        {children}
      </div>
      <div className="jdot" aria-hidden />
      <div className="jvisual">{visual}</div>
      {wide ? <div className="jwide">{wide}</div> : null}
    </li>
  );
}

/** A phone showing a code being scanned. */
export function PhoneArt() {
  return (
    <svg className="jart" viewBox="0 0 220 180" aria-hidden>
      <rect className="d1" x="70" y="12" width="80" height="150" rx="14" pathLength={1} />
      <line className="d2" x1="98" y1="26" x2="122" y2="26" pathLength={1} />
      <rect className="d2 acc" x="84" y="50" width="52" height="52" rx="4" pathLength={1} />
      <path className="d3 acc" d="M92 58h12v12H92zM116 58h12v12h-12zM92 82h12v12H92zM116 84h4m4 0h4m-12 6h12" pathLength={1} />
      <line className="d4 scan" x1="80" y1="76" x2="140" y2="76" pathLength={1} />
      <path className="d3 pink" d="M40 60c-12 10-12 34 0 44M28 50c-20 16-20 48 0 64" pathLength={1} />
      <path className="d3 pink" d="M180 60c12 10 12 34 0 44M192 50c20 16 20 48 0 64" pathLength={1} />
      <line className="d2" x1="100" y1="146" x2="120" y2="146" pathLength={1} />
    </svg>
  );
}

/** A window listing chats, some ticked. */
export function ChecklistArt() {
  return (
    <svg className="jart" viewBox="0 0 220 180" aria-hidden>
      <rect className="d1 pink" x="30" y="24" width="160" height="128" rx="8" pathLength={1} />
      <line className="d2 pink" x1="30" y1="46" x2="190" y2="46" pathLength={1} />
      <circle className="d2 acc" cx="44" cy="35" r="3" pathLength={1} />
      <circle className="d2" cx="56" cy="35" r="3" pathLength={1} />
      <circle className="d2" cx="68" cy="35" r="3" pathLength={1} />
      {[66, 92, 118].map((y, i) => (
        <g key={y}>
          <rect className="d3" x="46" y={y - 8} width="16" height="16" rx="4" pathLength={1} />
          {i !== 1 ? <path className="d4 acc" d={`M49 ${y}l4 4 7-8`} pathLength={1} /> : null}
          <line className="d3" x1="72" y1={y} x2={i === 1 ? 140 : 168} y2={y} pathLength={1} />
        </g>
      ))}
    </svg>
  );
}

/** A mind map growing from its centre. */
export function MindMapArt() {
  const kids: [number, number][] = [
    [40, 40],
    [180, 34],
    [190, 120],
    [36, 132],
    [110, 162],
  ];
  return (
    <svg className="jart" viewBox="0 0 220 180" aria-hidden>
      {kids.map(([x, y]) => (
        <line key={`l${x}`} className="d2" x1="110" y1="88" x2={x} y2={y} pathLength={1} />
      ))}
      <circle className="d1 acc" cx="110" cy="88" r="22" pathLength={1} />
      {kids.map(([x, y], i) => (
        <circle key={`c${x}`} className={`d3 node ${i % 2 ? 'pink' : 'blue'}`} cx={x} cy={y} r={i === 4 ? 8 : 11} pathLength={1} />
      ))}
      <path className="d4" d="M102 88h16M110 80v16" pathLength={1} />
    </svg>
  );
}
