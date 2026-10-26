export type Theme = 'night' | 'twilight';
export const THEME_KEY = 'threadmap-theme';

/** Runs before first paint (inlined in layout.tsx) so the stored or OS theme applies without a flash. */
export const themeBootScript = `try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='night'&&t!=='twilight')t=matchMedia('(prefers-color-scheme: light)').matches?'twilight':'night';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='night'}`;
