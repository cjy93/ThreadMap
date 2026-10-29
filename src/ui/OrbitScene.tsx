'use client';
// ThreadMap at a glance, as a small solar system: three orbits around the ThreadMap star —
// guardrails (inner), what it is built with (middle) and features (outer) — one planet per
// topic. Click a planet for a one- or two-line card under the sky. Our own SVG and CSS
// (globals.css "Orbit scene"); still under prefers-reduced-motion.
import { useState } from 'react';

// A fixed starfield (same on server and browser): a small seeded generator, not Math.random.
const STARS = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: 52 }, () => ({ x: Math.round(rnd() * 1000), y: Math.round(rnd() * 460), r: 0.7 + rnd() * 1.5, d: (rnd() * 5).toFixed(2), tint: rnd() }));
})();

type Group = 'guard' | 'built' | 'feature';
const ORBITS: Record<Group, { rx: number; ry: number; label: string }> = {
  guard: { rx: 205, ry: 70, label: 'Guardrails' },
  built: { rx: 325, ry: 110, label: 'Built with' },
  feature: { rx: 445, ry: 152, label: 'Features' },
};
const CX = 500;
const CY = 235;
const TILT = (-6 * Math.PI) / 180;

/** A point on an orbit (angle in degrees; 90 is the front, below the star). */
function onOrbit(g: Group, deg: number) {
  const { rx, ry } = ORBITS[g];
  const a = (deg * Math.PI) / 180;
  const x = rx * Math.cos(a);
  const y = ry * Math.sin(a);
  return { x: CX + x * Math.cos(TILT) - y * Math.sin(TILT), y: CY + x * Math.sin(TILT) + y * Math.cos(TILT) };
}

interface Planet {
  key: string;
  group: Group;
  deg: number;
  label: string;
  kind: 'pink' | 'teal' | 'green' | 'blue' | 'orange';
  r: number;
  text: string;
}

const PLANETS: Planet[] = [
  { key: 'leave', group: 'guard', deg: 200, label: 'LEAVING DELETES', kind: 'pink', r: 13, text: 'No ThreadMap tab open for 30 minutes: it unlinks your phone and deletes your chats, maps and photos. Keep a tab open to keep capturing.' },
  { key: 'opened', group: 'guard', deg: 290, label: 'ONLY WHAT YOU OPEN', kind: 'pink', r: 12, text: 'Only chats you open are stored and analysed. Others stay in memory for at most 5 minutes, then vanish.' },
  { key: 'readonly', group: 'guard', deg: 20, label: 'READ-ONLY', kind: 'pink', r: 12, text: 'ThreadMap never sends messages or read receipts.' },
  { key: 'encrypted', group: 'guard', deg: 110, label: 'ENCRYPTED', kind: 'pink', r: 13, text: 'Encrypted at rest and on every connection; your WhatsApp login keys are encrypted by ThreadMap itself.' },
  { key: 'whatsapp', group: 'built', deg: 245, label: 'WHATSAPP LINK', kind: 'teal', r: 15, text: 'A linked device, like WhatsApp Web, via Baileys: an unofficial library, so WhatsApp could restrict it.' },
  { key: 'supabase', group: 'built', deg: 335, label: 'SUPABASE', kind: 'teal', r: 15, text: 'PostgreSQL in Singapore holds your opened chats, maps and search.' },
  { key: 'nemotron', group: 'built', deg: 65, label: 'NVIDIA NEMOTRON', kind: 'green', r: 18, text: 'Nemotron Nano, Super and Super VL on Nebius Token Factory read your messages to build the map. Spending is capped per person.' },
  { key: 'brev', group: 'built', deg: 155, label: 'NVIDIA BREV', kind: 'green', r: 14, text: 'Runs ThreadMap in the cloud: web app, WhatsApp link and analysis worker in one container.' },
  { key: 'map', group: 'feature', deg: 215, label: 'MIND MAP', kind: 'orange', r: 20, text: 'Four roots with nested topics; every node opens its exact source messages and files.' },
  { key: 'ask', group: 'feature', deg: 305, label: 'ASK', kind: 'blue', r: 17, text: 'Exact words first, then partial words, then meaning — with an answer that cites its messages.' },
  { key: 'concept', group: 'feature', deg: 35, label: 'CONCEPT MAP', kind: 'blue', r: 16, text: 'Turns a Knowledge or Resources message into a concept map and study guide.' },
  { key: 'review', group: 'feature', deg: 125, label: 'READ & MISSED', kind: 'orange', r: 15, text: 'Tracks what you have read; small talk stays off the map but can be listed.' },
];

const GRADIENTS = [
  ['blue', '#c9d6ff', '#6e95ff', '#2f4fc4'],
  ['pink', '#ffd0e2', '#ff7fae', '#c63f78'],
  ['orange', '#ffe0bd', '#ffa24d', '#c8601c'],
  ['teal', '#c8fff8', '#4fd1c5', '#1f8a80'],
  ['green', '#e4ffc2', '#8fd14f', '#4f8a14'],
] as const;

export function OrbitScene() {
  const [picked, setPicked] = useState<string | null>(null);
  const planet = PLANETS.find((p) => p.key === picked) ?? null;
  return (
    <section className="orbit" aria-label="ThreadMap at a glance">
      <div className="orbit-scene">
        <svg viewBox="0 0 1000 470" role="group" aria-label="ThreadMap's guardrails, what it is built with and its features: click a planet">
          <defs>
            <radialGradient id="os-sun-glow">
              <stop offset="0" stopColor="#ffb15c" stopOpacity="0.55" />
              <stop offset="0.45" stopColor="#ff8a2b" stopOpacity="0.2" />
              <stop offset="1" stopColor="#ff8a2b" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="os-sun-core">
              <stop offset="0" stopColor="#fff4ec" />
              <stop offset="0.35" stopColor="#ffb3cf" />
              <stop offset="0.75" stopColor="#ff9a3c" />
              <stop offset="1" stopColor="#ff8a2b" stopOpacity="0" />
            </radialGradient>
            {GRADIENTS.map(([k, a, b, c]) => (
              <radialGradient key={k} id={`os-${k}`} cx="0.35" cy="0.3">
                <stop offset="0" stopColor={a} />
                <stop offset="0.55" stopColor={b} />
                <stop offset="1" stopColor={c} />
              </radialGradient>
            ))}
          </defs>

          {STARS.map((s, i) => (
            <circle key={i} className="os-star" cx={s.x} cy={s.y} r={s.r} fill={s.tint > 0.85 ? '#ffb15c' : s.tint > 0.7 ? '#ff9cc4' : '#dfe6ff'} style={{ animationDelay: `${s.d}s` }} />
          ))}

          {/* Legend: which orbit is which. */}
          <g className="os-legend">
            {(
              [
                ['guard', 'pink', 'GUARDRAILS'],
                ['built', 'teal', 'BUILT WITH'],
                ['feature', 'orange', 'FEATURES'],
              ] as const
            ).map(([g, k, t], i) => (
              <g key={g} transform={`translate(26 ${30 + i * 24})`}>
                <circle r="6" fill={`url(#os-${k})`} />
                <text x="14" y="5">
                  {t}
                </text>
              </g>
            ))}
          </g>

          <g className="os-orbits">
            {(Object.keys(ORBITS) as Group[]).map((g) => (
              <ellipse key={g} className={`os-orbit-${g}`} cx={CX} cy={CY} rx={ORBITS[g].rx} ry={ORBITS[g].ry} transform={`rotate(-6 ${CX} ${CY})`} />
            ))}
          </g>

          <circle className="os-sun-glow" cx={CX} cy={CY} r="150" fill="url(#os-sun-glow)" />
          <circle className="os-sun-core" cx={CX} cy={CY} r="44" fill="url(#os-sun-core)" />
          <text className="os-sun-label" x={CX} y={CY + 4}>
            THREADMAP
          </text>

          {PLANETS.map((p) => {
            const { x, y } = onOrbit(p.group, p.deg);
            const above = Math.sin((p.deg * Math.PI) / 180) < 0;
            const on = p.key === picked;
            return (
              <g
                key={p.key}
                className={`os-planet os-${p.kind} ${on ? 'os-on' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={`${ORBITS[p.group].label}: ${p.label.toLowerCase()}`}
                onClick={() => setPicked(on ? null : p.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPicked(on ? null : p.key);
                  }
                }}
              >
                {on ? <circle className="os-pulse" cx={x} cy={y} r={p.r + 5} /> : null}
                <circle className="os-body" cx={x} cy={y} r={p.r} fill={`url(#os-${p.kind})`} />
                {p.key === 'whatsapp' || p.key === 'map' ? <ellipse className="os-ring" cx={x} cy={y} rx={p.r + 11} ry={5} transform={`rotate(-14 ${x} ${y})`} /> : null}
                {p.group === 'guard' ? <circle className="os-shield" cx={x} cy={y} r={p.r + 7} /> : null}
                <text className="os-label" x={x} y={above ? y - p.r - 10 : y + p.r + 19}>
                  {p.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className={`orbit-card ${planet ? `card-${planet.kind}` : 'card-hint'}`} aria-live="polite">
        {planet ? (
          <>
            <div className="jkicker">
              {ORBITS[planet.group].label} · {planet.label}
            </div>
            <p>{planet.text}</p>
          </>
        ) : (
          <p className="counts">Click a planet: pink are guardrails, teal and green what ThreadMap is built with, blue and orange its features.</p>
        )}
      </div>
    </section>
  );
}
