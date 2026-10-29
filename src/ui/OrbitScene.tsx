'use client';
// The Connect page's three steps as planets around a glowing star (ThreadMap and NVIDIA
// Nemotron): LINK, CHOOSE and MAP on dashed orbits, each with a trail into the star, in a
// twinkling starfield with a small "mind map" constellation. The step to do next pulses, a
// finished one is ticked, and each planet jumps to its step. Our own SVG and CSS
// (globals.css "Orbit scene"); still under prefers-reduced-motion.

type StepState = 'done' | 'now' | 'later';

// A fixed starfield (same on server and browser): a small seeded generator, not Math.random.
const STARS = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: 46 }, () => ({ x: Math.round(rnd() * 1000), y: Math.round(rnd() * 400), r: 0.8 + rnd() * 1.6, d: (rnd() * 5).toFixed(2), tint: rnd() }));
})();

const PLANETS = [
  { n: 1, label: 'LINK', x: 165, y: 286, r: 26, kind: 'blue', trail: 'M165 286 C 260 268, 330 258, 420 250', lx: 165, ly: 345 },
  { n: 2, label: 'CHOOSE', x: 452, y: 352, r: 20, kind: 'pink', trail: 'M452 352 C 462 320, 476 296, 496 276', lx: 452, ly: 398 },
  { n: 3, label: 'MAP', x: 846, y: 150, r: 30, kind: 'orange', trail: 'M846 150 C 760 172, 680 198, 586 226', lx: 846, ly: 214 },
] as const;

export function OrbitScene({ states, title }: { states: [StepState, StepState, StepState]; title: string }) {
  return (
    <div className="orbit-scene">
      <svg viewBox="0 0 1000 410" role="img" aria-label={title}>
        <defs>
          <radialGradient id="os-sun-glow">
            <stop offset="0" stopColor="#ffb15c" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="#ff8a2b" stopOpacity="0.22" />
            <stop offset="1" stopColor="#ff8a2b" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="os-sun-core">
            <stop offset="0" stopColor="#fff4ec" />
            <stop offset="0.35" stopColor="#ffb3cf" />
            <stop offset="0.75" stopColor="#ff9a3c" />
            <stop offset="1" stopColor="#ff8a2b" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="os-blue" cx="0.35" cy="0.3">
            <stop offset="0" stopColor="#c9d6ff" />
            <stop offset="0.5" stopColor="#6e95ff" />
            <stop offset="1" stopColor="#2f4fc4" />
          </radialGradient>
          <radialGradient id="os-pink" cx="0.35" cy="0.3">
            <stop offset="0" stopColor="#ffd0e2" />
            <stop offset="0.55" stopColor="#ff7fae" />
            <stop offset="1" stopColor="#c63f78" />
          </radialGradient>
          <radialGradient id="os-orange" cx="0.35" cy="0.3">
            <stop offset="0" stopColor="#ffe0bd" />
            <stop offset="0.55" stopColor="#ffa24d" />
            <stop offset="1" stopColor="#c8601c" />
          </radialGradient>
          <linearGradient id="os-trail-blue" x1="0" x2="1">
            <stop offset="0" stopColor="#6e95ff" stopOpacity="0.1" />
            <stop offset="1" stopColor="#a9bdff" />
          </linearGradient>
          <linearGradient id="os-trail-pink" x1="0" x2="0" y1="1" y2="0">
            <stop offset="0" stopColor="#ff7fae" stopOpacity="0.2" />
            <stop offset="1" stopColor="#ff9cc4" />
          </linearGradient>
          <linearGradient id="os-trail-orange" x1="1" x2="0">
            <stop offset="0" stopColor="#ffb15c" stopOpacity="0.15" />
            <stop offset="1" stopColor="#ffb15c" />
          </linearGradient>
        </defs>

        {STARS.map((s, i) => (
          <circle key={i} className="os-star" cx={s.x} cy={s.y} r={s.r} fill={s.tint > 0.85 ? '#ffb15c' : s.tint > 0.7 ? '#ff9cc4' : '#dfe6ff'} style={{ animationDelay: `${s.d}s` }} />
        ))}

        {/* A small constellation shaped like a mind map. */}
        <g className="os-const">
          <path d="M800 34 L792 92 L812 128 L770 166 M812 128 L858 170 M792 92 L846 70" />
          {[
            [800, 34],
            [792, 92],
            [812, 128],
            [770, 166],
            [858, 170],
            [846, 70],
          ].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={2.6} />
          ))}
          <text x="874" y="40">
            MIND MAP
          </text>
        </g>

        <g className="os-orbits">
          <ellipse cx="500" cy="250" rx="400" ry="120" transform="rotate(-9 500 250)" />
          <ellipse cx="500" cy="250" rx="255" ry="82" transform="rotate(-9 500 250)" />
        </g>

        <circle className="os-sun-glow" cx="500" cy="250" r="190" fill="url(#os-sun-glow)" />
        <circle className="os-sun-core" cx="500" cy="250" r="62" fill="url(#os-sun-core)" />
        <text className="os-sun-label" x="500" y="338">
          THREADMAP · NEMOTRON
        </text>

        {PLANETS.map((p, i) => {
          const st = states[i];
          return (
            <a key={p.n} href={`#step-${p.n}`} className={`os-planet os-${p.kind} os-${st}`} aria-label={`Step ${p.n}: ${p.label.toLowerCase()}${st === 'done' ? ' (done)' : st === 'now' ? ' (next)' : ''}`}>
              <path className="os-trail" d={p.trail} stroke={`url(#os-trail-${p.kind})`} />
              {st === 'now' ? <circle className="os-pulse" cx={p.x} cy={p.y} r={p.r + 6} /> : null}
              <circle className="os-body" cx={p.x} cy={p.y} r={p.r} fill={`url(#os-${p.kind})`} />
              {p.kind === 'blue' ? <ellipse className="os-ring" cx={p.x} cy={p.y} rx={p.r + 14} ry={7} transform={`rotate(-14 ${p.x} ${p.y})`} /> : null}
              {p.kind === 'pink' ? (
                <g className="os-stripes">
                  <line x1={p.x - p.r + 3} y1={p.y - 5} x2={p.x + p.r - 3} y2={p.y - 5} />
                  <line x1={p.x - p.r + 2} y1={p.y + 4} x2={p.x + p.r - 2} y2={p.y + 4} />
                </g>
              ) : null}
              <text className="os-label" x={p.lx} y={p.ly}>
                {st === 'done' ? `${p.label} ✓` : p.label}
              </text>
            </a>
          );
        })}
      </svg>
    </div>
  );
}
