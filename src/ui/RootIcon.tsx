// Cartoon mascots for the four roots: a reading book (Knowledge), chatting bubbles
// (General Chat), a party calendar (Events and Activities) and a paper-clipped
// folder (Resources). Fixed cheerful fills with a dark ink outline read in both themes.
const INK = '#231a3a';
const sw = { stroke: INK, strokeWidth: 3, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };

function Face({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <circle cx={-6} cy={0} r={2.4} fill={INK} />
      <circle cx={6} cy={0} r={2.4} fill={INK} />
      <path d="M-5 5 Q0 10 5 5" fill="none" {...sw} strokeWidth={2.4} />
      <circle cx={-10} cy={5} r={2.2} fill="#ff8fb1" opacity={0.8} />
      <circle cx={10} cy={5} r={2.2} fill="#ff8fb1" opacity={0.8} />
    </g>
  );
}

function Knowledge() {
  return (
    <>
      {/* Open book with a little lightbulb idea above it. */}
      <path d="M32 22 C24 16 14 16 6 19 V52 C14 49 24 49 32 55 C40 49 50 49 58 52 V19 C50 16 40 16 32 22 Z" fill="#8fb3ff" {...sw} />
      <path d="M32 22 V55" fill="none" {...sw} />
      <path d="M10 23 C16 21 23 21 28 25 V48 C23 45 16 45 10 47 Z" fill="#ffffff" {...sw} strokeWidth={2} />
      <path d="M54 23 C48 21 41 21 36 25 V48 C41 45 48 45 54 47 Z" fill="#ffffff" {...sw} strokeWidth={2} />
      <Face x={19} y={34} s={0.7} />
      <Face x={45} y={34} s={0.7} />
      <circle cx={32} cy={8} r={6} fill="#ffd54d" {...sw} strokeWidth={2.4} />
      <path d="M22 6 L19 4 M42 6 L45 4 M32 -1 V-3" {...sw} strokeWidth={2} />
    </>
  );
}

function GeneralChat() {
  return (
    <>
      {/* Two speech bubbles talking to each other. */}
      <path d="M8 12 H38 A6 6 0 0 1 44 18 V34 A6 6 0 0 1 38 40 H20 L11 48 V40 H8 A6 6 0 0 1 2 34 V18 A6 6 0 0 1 8 12 Z" fill="#ff9ec4" {...sw} />
      <Face x={23} y={24} s={0.85} />
      <path d="M30 30 H56 A6 6 0 0 1 62 36 V48 A6 6 0 0 1 56 54 H54 V61 L46 54 H30 A6 6 0 0 1 24 48 V36 A6 6 0 0 1 30 30 Z" fill="#ffffff" {...sw} />
      <circle cx={35} cy={42} r={2.6} fill={INK} />
      <circle cx={43} cy={42} r={2.6} fill={INK} />
      <circle cx={51} cy={42} r={2.6} fill={INK} />
    </>
  );
}

function Events() {
  return (
    <>
      {/* Smiling calendar page with confetti. */}
      <rect x={8} y={14} width={44} height={42} rx={7} fill="#ffffff" {...sw} />
      <path d="M8 21 A7 7 0 0 1 15 14 H45 A7 7 0 0 1 52 21 V27 H8 Z" fill="#ffb454" {...sw} />
      <path d="M19 9 V19 M41 9 V19" {...sw} strokeWidth={3.4} />
      <Face x={30} y={39} s={0.95} />
      <path d="M56 8 L60 4 M58 16 L63 16 M52 3 L52 -1" stroke="#ff5f8f" strokeWidth={3} strokeLinecap="round" />
      <circle cx={4} cy={8} r={2.5} fill="#4fd1c5" />
      <rect x={58} y={24} width={4} height={4} rx={1} fill="#6e95ff" transform="rotate(20 60 26)" />
    </>
  );
}

function Resources() {
  return (
    <>
      {/* Folder with a paper clip and a sheet peeking out. */}
      <path d="M4 18 A5 5 0 0 1 9 13 H24 L29 19 H55 A5 5 0 0 1 60 24 V51 A5 5 0 0 1 55 56 H9 A5 5 0 0 1 4 51 Z" fill="#4fd1c5" {...sw} />
      <rect x={14} y={10} width={34} height={22} rx={3} fill="#ffffff" {...sw} strokeWidth={2.4} transform="rotate(-6 31 21)" />
      <path d="M4 27 H60 V51 A5 5 0 0 1 55 56 H9 A5 5 0 0 1 4 51 Z" fill="#7fe3d9" {...sw} />
      <path d="M47 4 V22 A5 5 0 0 1 37 22 V8 A3 3 0 0 1 43 8 V20" fill="none" stroke="#8c9ac8" strokeWidth={3} strokeLinecap="round" />
      <Face x={32} y={39} s={0.95} />
    </>
  );
}

const ICONS: Record<string, () => React.JSX.Element> = { KNOWLEDGE: Knowledge, GENERAL_CHAT: GeneralChat, EVENTS_ACTIVITIES: Events, RESOURCES: Resources };

export function RootIcon({ root, size = 40, className }: { root: string; size?: number; className?: string }) {
  const Icon = ICONS[root];
  if (!Icon) return null;
  return (
    <svg className={className} width={size} height={size} viewBox="-4 -6 72 72" aria-hidden focusable="false" style={{ overflow: 'visible', flex: 'none' }}>
      <Icon />
    </svg>
  );
}
