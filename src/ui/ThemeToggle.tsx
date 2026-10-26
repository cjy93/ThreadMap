'use client';
import { useSyncExternalStore } from 'react';
import { THEME_KEY, type Theme } from './theme';

// The theme lives on <html data-theme>; observe it so every toggle on the page stays in sync.
const subscribe = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
};
const current = (): Theme => (document.documentElement.dataset.theme === 'twilight' ? 'twilight' : 'night');

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => null);
  if (!theme) return null;
  const next: Theme = theme === 'night' ? 'twilight' : 'night';
  return (
    <button
      className="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // storage blocked: the choice lasts for this page only
        }
      }}
    >
      {theme === 'night' ? '☾ Night' : '☀ Twilight'}
    </button>
  );
}
