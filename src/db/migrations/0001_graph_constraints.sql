-- Recursive topic tree integrity enforced in the database as defense in depth.
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_fk"
  FOREIGN KEY ("parent_id") REFERENCES "topics"("id") ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_root_shape_ck"
  CHECK (("kind" = 'CATEGORY' AND "parent_id" IS NULL) OR ("kind" = 'TOPIC' AND "parent_id" IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "topics_one_category_per_root_uq" ON "topics" ("chat_id", "root") WHERE "kind" = 'CATEGORY';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION threadmap_check_topic_parent() RETURNS trigger AS $$
DECLARE
  p_chat uuid;
  p_root text;
  p_ws uuid;
  p_retired uuid;
  cycle_found boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'topic cannot be its own parent' USING ERRCODE = 'check_violation';
  END IF;
  SELECT chat_id, root, workspace_id, retired_into INTO p_chat, p_root, p_ws, p_retired
    FROM topics WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'topic parent does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_chat <> NEW.chat_id OR p_root <> NEW.root OR p_ws <> NEW.workspace_id THEN
    RAISE EXCEPTION 'topic parent must be in the same workspace, chat and root' USING ERRCODE = 'check_violation';
  END IF;
  IF p_retired IS NOT NULL AND NEW.retired_into IS NULL THEN
    RAISE EXCEPTION 'topic parent is retired' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE anc(id, parent_id) AS (
      SELECT id, parent_id FROM topics WHERE id = NEW.parent_id
      UNION
      SELECT t.id, t.parent_id FROM topics t JOIN anc a ON t.id = a.parent_id
    )
    SELECT EXISTS (SELECT 1 FROM anc WHERE id = NEW.id) INTO cycle_found;
    IF cycle_found THEN
      RAISE EXCEPTION 'topic move would create a cycle' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "topics_parent_check"
  BEFORE INSERT OR UPDATE OF "parent_id", "chat_id", "root" ON "topics"
  FOR EACH ROW EXECUTE FUNCTION threadmap_check_topic_parent();
--> statement-breakpoint
-- Placements must target a topic in the same chat as the message.
CREATE OR REPLACE FUNCTION threadmap_check_placement() RETURNS trigger AS $$
DECLARE
  t_chat uuid;
  m_chat uuid;
BEGIN
  SELECT chat_id INTO t_chat FROM topics WHERE id = NEW.topic_id;
  SELECT chat_id INTO m_chat FROM messages WHERE id = NEW.message_id;
  IF t_chat IS DISTINCT FROM NEW.chat_id OR m_chat IS DISTINCT FROM NEW.chat_id THEN
    RAISE EXCEPTION 'placement must reference a topic and message in its own chat' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "placements_scope_check"
  BEFORE INSERT OR UPDATE ON "placements"
  FOR EACH ROW EXECUTE FUNCTION threadmap_check_placement();
--> statement-breakpoint
-- Trigram index for case-insensitive Unicode substring search on normalized text.
-- pg_trgm is optional: if unavailable the search falls back to a sequential scan.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXECUTE 'CREATE INDEX IF NOT EXISTS messages_search_trgm_idx ON messages USING gin (search_text gin_trgm_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable; search uses sequential scan';
END;
$$;
