'use client';
// A chat's WhatsApp profile photo, or its initials when there is none.
import { useState } from 'react';

/** First letters of the first two words that contain a letter ("Ming Ming 💜" → "MM"). */
export function initials(title: string): string {
  const words = title.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w].find((ch) => /\p{L}/u.test(ch)) ?? '');
  return letters.join('').toUpperCase() || '#';
}

export function Avatar({ title, url, size = 36 }: { title: string; url: string | null; size?: number }) {
  // A photo that fails to load (e.g. its stored copy is gone and is being fetched again) shows initials, never a broken image.
  const [failed, setFailed] = useState<string | null>(null);
  return url && failed !== url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="avatar" src={url} alt="" width={size} height={size} loading="lazy" style={{ width: size, height: size }} onError={() => setFailed(url)} />
  ) : (
    <span className="avatar" aria-hidden style={{ width: size, height: size }}>
      {initials(title)}
    </span>
  );
}
