ALTER TABLE "messages" ADD COLUMN "starred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "starred_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_starred_idx" ON "messages" USING btree ("chat_id") WHERE "messages"."starred";