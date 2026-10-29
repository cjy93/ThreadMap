-- Older messages to import per chat, chosen when the chat is opened (null = WHATSAPP_HISTORY_MAX_MESSAGES_PER_CHAT).
ALTER TABLE "chats" ADD COLUMN "history_limit" integer;
