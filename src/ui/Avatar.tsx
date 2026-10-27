// A chat's WhatsApp profile photo, or its initials when there is none.

/** First letters of the first two words that contain a letter ("Ming Ming 💜" → "MM"). */
export function initials(title: string): string {
  const words = title.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w].find((ch) => /\p{L}/u.test(ch)) ?? '');
  return letters.join('').toUpperCase() || '#';
}

export function Avatar({ title, url, size = 36 }: { title: string; url: string | null; size?: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="avatar" src={url} alt="" width={size} height={size} loading="lazy" style={{ width: size, height: size }} />
  ) : (
    <span className="avatar" aria-hidden style={{ width: size, height: size }}>
      {initials(title)}
    </span>
  );
}
