-- Fourth fixed category root "Events and Activities" for every existing chat.
-- New chats get it from ensureRoots(); the root column is plain text, so no type change is needed.
INSERT INTO "topics" ("workspace_id", "chat_id", "root", "kind", "parent_id", "title", "provenance")
SELECT DISTINCT "workspace_id", "chat_id", 'EVENTS_ACTIVITIES', 'CATEGORY', NULL::uuid, 'Events and Activities', 'system'
FROM "topics"
WHERE "kind" = 'CATEGORY'
ON CONFLICT DO NOTHING;
