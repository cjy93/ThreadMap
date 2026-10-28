CREATE TABLE "usage_allowance" (
	"subject" text PRIMARY KEY NOT NULL,
	"usd_micros_reserved" bigint DEFAULT 0 NOT NULL,
	"usd_micros_used" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
