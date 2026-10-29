-- The small-talk rule narrowed: answers and shared observations are never small talk. Clear the
-- flags the old rule set (courtesy-only messages stay, see 0015), so the next Refresh or rebuild
-- screens them again under the new rule.
UPDATE "messages" m SET "filler" = NULL
WHERE m."filler" IS TRUE
  AND NOT (m."kind" = 'text' AND COALESCE(m."body", '') ~ '[^[:space:]]'
    AND regexp_replace(regexp_replace(lower(m."body"), '[^[:alpha:]]+', ' ', 'g'), '\m(thank you very much|thank you so much|thanks so much|thanks a lot|no problem|no worries|thank you|thank u|got it|well done|done|okay|okie|okies|okk|ok|kk|k|noted|thanks|thank|thx|tx|tq|ty|tyvm|tysm|received|cool|nice|great|alright|alrighty|roger|lol|lmao|wow|yay|welcome|np|ah|lah|la|leh|liao|alr|already|h[ae](h[ae])+)\M', ' ', 'g') ~ '^[[:space:]]*$');
