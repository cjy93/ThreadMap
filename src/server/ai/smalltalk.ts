// Courtesy-only messages ("Done", "Thank you", "ok noted", "haha", an emoji) are small talk by
// rule, not by the model's judgement: the model kept "Done" as an answer to the request it
// replied to, but the request already carries the topic. Anything with another word in it
// ("Mind adding dhui@... too please thank you", "Can access now, thanks!") is left to the model.
// Migration 0015 applies the same pattern to messages read before this rule; keep them in step.
import { sql, type SQL } from 'drizzle-orm';

/** Courtesy words and phrases (longest first); "yes", "no", "sure" are left out: they can answer. */
export const COURTESY_PHRASES = [
  'thank you very much',
  'thank you so much',
  'thanks so much',
  'thanks a lot',
  'no problem',
  'no worries',
  'thank you',
  'thank u',
  'got it',
  'well done',
  'done',
  'okay',
  'okie',
  'okies',
  'okk',
  'ok',
  'kk',
  'k',
  'noted',
  'thanks',
  'thank',
  'thx',
  'tx',
  'tq',
  'ty',
  'tyvm',
  'tysm',
  'received',
  'cool',
  'nice',
  'great',
  'alright',
  'alrighty',
  'roger',
  'lol',
  'lmao',
  'wow',
  'yay',
  'welcome',
  'np',
  'ah',
  'lah',
  'la',
  'leh',
  'liao',
  'alr',
  'already',
  'h[ae](h[ae])+',
];

const alternation = COURTESY_PHRASES.join('|');
/** PostgreSQL pattern (ARE word boundaries); see migration 0015. */
export const COURTESY_PG_PATTERN = `\\m(${alternation})\\M`;
const COURTESY_JS = new RegExp(`(?<!\\p{L})(${alternation})(?!\\p{L})`, 'gu');

/** Whether a message's text is only courtesy words, emoji and punctuation. */
export function isCourtesyOnly(body: string | null | undefined): boolean {
  if (!body || !body.trim()) return false;
  const words = body.toLowerCase().replace(/[^\p{L}]+/gu, ' ');
  return words.replace(COURTESY_JS, ' ').trim() === '';
}

/** The same test in SQL, for a messages row aliased `m`. */
export function courtesyOnlySql(m: SQL = sql`m`): SQL {
  return sql`(${m}.kind = 'text' AND COALESCE(${m}.body, '') ~ '[^[:space:]]'
    AND regexp_replace(regexp_replace(lower(${m}.body), '[^[:alpha:]]+', ' ', 'g'), ${COURTESY_PG_PATTERN}, ' ', 'g') ~ '^[[:space:]]*$')`;
}
