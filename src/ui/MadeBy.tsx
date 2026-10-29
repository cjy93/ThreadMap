// "About the maker": the author's name and LinkedIn, from author.ts (hidden until a name is set).
import { AUTHOR } from './author';

export function MadeBy() {
  if (!AUTHOR.name.trim()) return null;
  const initials = AUTHOR.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <section className="made-by" aria-label="About the maker">
      <div className="made-by-mark" aria-hidden>
        {initials}
      </div>
      <div>
        <div className="kicker">Made by</div>
        <div className="made-by-name">{AUTHOR.name}</div>
        {AUTHOR.role ? <div className="counts">{AUTHOR.role}</div> : null}
      </div>
      {AUTHOR.linkedin ? (
        <a className="made-by-link" href={AUTHOR.linkedin} target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.5h4V21H3zM9.5 9.5h3.8v1.6h.06c.53-1 1.83-2.06 3.77-2.06 4.03 0 4.77 2.65 4.77 6.1V21h-4v-5.1c0-1.22-.02-2.79-1.7-2.79-1.7 0-1.96 1.33-1.96 2.7V21h-4z"
            />
          </svg>
          LinkedIn
        </a>
      ) : null}
    </section>
  );
}
