ALTER TABLE "attachments" ADD COLUMN "thumbnail" "bytea";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "ai_description" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "ai_described_by" text;