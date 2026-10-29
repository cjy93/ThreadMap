-- Courtesy-only messages ("Done", "Thank you", "ok noted", "haha", an emoji) are small talk by
-- rule (src/server/ai/smalltalk.ts; keep the pattern in step). Flags those already read.
UPDATE "messages" m SET "filler" = true
WHERE m."kind" = 'text' AND COALESCE(m."body", '') ~ '[^[:space:]]' AND m."filler" IS DISTINCT FROM true
  AND regexp_replace(regexp_replace(lower(m."body"), '[^[:alpha:]]+', ' ', 'g'), '\m(thank you very much|thank you so much|thanks so much|thanks a lot|no problem|no worries|thank you|thank u|got it|well done|done|okay|okie|okies|okk|ok|kk|k|noted|thanks|thank|thx|tx|tq|ty|tyvm|tysm|received|cool|nice|great|alright|alrighty|roger|lol|lmao|wow|yay|welcome|np|ah|lah|la|leh|liao|alr|already|h[ae](h[ae])+)\M', ' ', 'g') ~ '^[[:space:]]*$';
