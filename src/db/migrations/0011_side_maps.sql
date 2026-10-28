ALTER TABLE "chats" ADD COLUMN "map_of" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "map_side" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_map_of_chats_id_fk" FOREIGN KEY ("map_of") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A one-sided map places messages of the chat it maps (chats.map_of).
CREATE OR REPLACE FUNCTION threadmap_check_placement() RETURNS trigger AS $$
DECLARE
  t_chat uuid;
  m_chat uuid;
  of_chat uuid;
BEGIN
  SELECT chat_id INTO t_chat FROM topics WHERE id = NEW.topic_id;
  SELECT chat_id INTO m_chat FROM messages WHERE id = NEW.message_id;
  SELECT map_of INTO of_chat FROM chats WHERE id = NEW.chat_id;
  IF t_chat IS DISTINCT FROM NEW.chat_id OR m_chat IS DISTINCT FROM COALESCE(of_chat, NEW.chat_id) THEN
    RAISE EXCEPTION 'placement must reference a topic and message in its own chat' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
