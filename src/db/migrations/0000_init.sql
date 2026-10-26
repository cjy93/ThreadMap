CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"logical_job_id" uuid NOT NULL,
	"input_fingerprint" text NOT NULL,
	"input_messages" jsonb NOT NULL,
	"pipeline_version" text NOT NULL,
	"deletion_generation" integer NOT NULL,
	"selection_epoch" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"safe_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analysis_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analysis_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"deletion_generation" integer NOT NULL,
	"selection_epoch" integer NOT NULL,
	"dispatched_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"unit_key" text NOT NULL,
	"primary_root" text NOT NULL,
	"topic_terms" jsonb NOT NULL,
	"message_refs" jsonb NOT NULL,
	"summary_bullets" jsonb NOT NULL,
	"resource_refs" jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"assigned_topic_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"media_type" text NOT NULL,
	"declared_mime" text,
	"detected_mime" text,
	"filename" text,
	"declared_size" bigint,
	"byte_count" bigint,
	"content_hash" text,
	"availability" text NOT NULL,
	"object_key" text,
	"media_ref" "bytea",
	"failure_reason" text,
	"view_once" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_records" (
	"linked_account_id" uuid NOT NULL,
	"category" text NOT NULL,
	"record_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_records_linked_account_id_category_record_id_pk" PRIMARY KEY("linked_account_id","category","record_id")
);
--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"logical_job_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"max_calls" integer NOT NULL,
	"max_usd_micros" bigint NOT NULL,
	"calls_reserved" integer DEFAULT 0 NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"usd_micros_reserved" bigint DEFAULT 0 NOT NULL,
	"usd_micros_used" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_review_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"pairs" jsonb NOT NULL,
	"executed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_aliases" (
	"chat_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"alias_jid" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"linked_account_id" uuid,
	"source_kind" text NOT NULL,
	"native_jid" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"selection_epoch" integer DEFAULT 0 NOT NULL,
	"history_mode" text DEFAULT 'available_history' NOT NULL,
	"new_only_cutoff" timestamp with time zone,
	"excluded" boolean DEFAULT false NOT NULL,
	"deletion_generation" integer DEFAULT 0 NOT NULL,
	"source_version" bigint DEFAULT 0 NOT NULL,
	"graph_version" bigint DEFAULT 0 NOT NULL,
	"taxonomy_version" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_analysis_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"claim_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "claim_evidence_claim_id_message_id_pk" PRIMARY KEY("claim_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "connection_status" (
	"linked_account_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'disconnected' NOT NULL,
	"detail" text,
	"last_event_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"connected_since" timestamp with time zone,
	"uncertain_intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remote_unlink_confirmed" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"linked_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_leases" (
	"linked_account_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"target_native_id" text NOT NULL,
	"type" text NOT NULL,
	"edit_body" text,
	"event_time" timestamp with time zone,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_chat_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"a_chat_id" uuid NOT NULL,
	"a_topic_id" uuid NOT NULL,
	"b_chat_id" uuid NOT NULL,
	"b_topic_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"reason" text NOT NULL,
	"a_evidence" jsonb NOT NULL,
	"b_evidence" jsonb NOT NULL,
	"status" text NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"dismissed_by" text,
	"generation_version" integer DEFAULT 0 NOT NULL,
	"verifier_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_budget" (
	"day" text PRIMARY KEY NOT NULL,
	"max_usd_micros" bigint NOT NULL,
	"usd_micros_reserved" bigint DEFAULT 0 NOT NULL,
	"usd_micros_used" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"title" text NOT NULL,
	"unit_key" text,
	"provenance" text NOT NULL,
	"taxonomy_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_fingerprint" text,
	"connection_generation" integer DEFAULT 0 NOT NULL,
	"desired_state" text DEFAULT 'disconnected' NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_revisions" (
	"message_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text,
	"digest" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_revisions_message_id_revision_pk" PRIMARY KEY("message_id","revision")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"native_key_hash" text NOT NULL,
	"native_id" text NOT NULL,
	"from_me" boolean NOT NULL,
	"native_key" jsonb NOT NULL,
	"sender_participant_id" uuid,
	"sender_label" text NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"body" text,
	"search_text" text,
	"sent_at" timestamp with time zone,
	"sent_at_raw" text,
	"received_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"revision_digest" text NOT NULL,
	"reply_to_native_id" text,
	"expires_at" timestamp with time zone,
	"ingest_event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"logical_job_id" uuid,
	"job_id" uuid,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"operation" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"usd_micros" bigint,
	"duration_ms" integer NOT NULL,
	"safe_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_aliases" (
	"workspace_id" uuid NOT NULL,
	"alias_jid" text NOT NULL,
	"participant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_aliases_workspace_id_alias_jid_pk" PRIMARY KEY("workspace_id","alias_jid")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_jid" text NOT NULL,
	"display_name" text,
	"is_self" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"discussion_id" uuid,
	"is_primary" boolean DEFAULT false NOT NULL,
	"provenance" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"analyzed_revision" integer DEFAULT 1 NOT NULL,
	"taxonomy_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_heartbeats" (
	"process_name" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"canonical_url" text,
	"attachment_id" uuid,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_state" (
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reviewed_revision" integer,
	"read_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_state_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "review_versions" (
	"user_id" text NOT NULL,
	"chat_id" uuid NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "review_versions_user_id_chat_id_pk" PRIMARY KEY("user_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "runtime_settings" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"public_origin" text NOT NULL,
	"config_revision" text NOT NULL,
	"bootstrapped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bootstrapped_by" text NOT NULL,
	"audit" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "summary_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"topic_id" uuid,
	"discussion_id" uuid,
	"text" text NOT NULL,
	"input_digest" text NOT NULL,
	"input_message_ids" jsonb NOT NULL,
	"valid" boolean DEFAULT true NOT NULL,
	"model_id" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_coverage" (
	"chat_id" uuid PRIMARY KEY NOT NULL,
	"history_state" text DEFAULT 'not_requested' NOT NULL,
	"earliest_at" timestamp with time zone,
	"latest_at" timestamp with time zone,
	"history_count" integer DEFAULT 0 NOT NULL,
	"live_count" integer DEFAULT 0 NOT NULL,
	"excluded_before_cutoff" integer DEFAULT 0 NOT NULL,
	"unknown_time_excluded" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_frontiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"logical_job_id" uuid NOT NULL,
	"parent_topic_id" uuid NOT NULL,
	"input_messages" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"topic_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_merge_map" (
	"retired_id" uuid PRIMARY KEY NOT NULL,
	"surviving_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"root" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" text NOT NULL,
	"title_locked" boolean DEFAULT false NOT NULL,
	"parent_locked" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"retired_into" uuid,
	"taxonomy_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"is_anonymous" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_chat_view_preferences" (
	"user_id" text NOT NULL,
	"chat_id" uuid NOT NULL,
	"show_depth" text NOT NULL,
	"collapsed_node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"focus_node_id" uuid,
	"auto_read_enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_chat_view_preferences_user_id_chat_id_pk" PRIMARY KEY("user_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"mode" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone,
	"deletion_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_outbox" ADD CONSTRAINT "analysis_outbox_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_units" ADD CONSTRAINT "analysis_units_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_records" ADD CONSTRAINT "auth_records_linked_account_id_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_aliases" ADD CONSTRAINT "chat_aliases_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_linked_account_id_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_summary_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."summary_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_status" ADD CONSTRAINT "connection_status_linked_account_id_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_commands" ADD CONSTRAINT "connector_commands_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_commands" ADD CONSTRAINT "connector_commands_linked_account_id_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_leases" ADD CONSTRAINT "connector_leases_linked_account_id_linked_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_events" ADD CONSTRAINT "control_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_chat_links" ADD CONSTRAINT "cross_chat_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_chat_links" ADD CONSTRAINT "cross_chat_links_a_chat_id_chats_id_fk" FOREIGN KEY ("a_chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_chat_links" ADD CONSTRAINT "cross_chat_links_a_topic_id_topics_id_fk" FOREIGN KEY ("a_topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_chat_links" ADD CONSTRAINT "cross_chat_links_b_chat_id_chats_id_fk" FOREIGN KEY ("b_chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_chat_links" ADD CONSTRAINT "cross_chat_links_b_topic_id_topics_id_fk" FOREIGN KEY ("b_topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_participant_id_participants_id_fk" FOREIGN KEY ("sender_participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_aliases" ADD CONSTRAINT "participant_aliases_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_state" ADD CONSTRAINT "review_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_state" ADD CONSTRAINT "review_state_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_versions" ADD CONSTRAINT "review_versions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_claims" ADD CONSTRAINT "summary_claims_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_claims" ADD CONSTRAINT "summary_claims_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_claims" ADD CONSTRAINT "summary_claims_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_coverage" ADD CONSTRAINT "sync_coverage_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_frontiers" ADD CONSTRAINT "taxonomy_frontiers_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_frontiers" ADD CONSTRAINT "taxonomy_frontiers_parent_topic_id_topics_id_fk" FOREIGN KEY ("parent_topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_overrides" ADD CONSTRAINT "taxonomy_overrides_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_view_preferences" ADD CONSTRAINT "user_chat_view_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_chat_view_preferences" ADD CONSTRAINT "user_chat_view_preferences_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_jobs_fingerprint_uq" ON "analysis_jobs" USING btree ("chat_id","input_fingerprint");--> statement-breakpoint
CREATE INDEX "analysis_jobs_status_idx" ON "analysis_jobs" USING btree ("chat_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_outbox_uq" ON "analysis_outbox" USING btree ("message_id","revision");--> statement-breakpoint
CREATE INDEX "analysis_outbox_pending_idx" ON "analysis_outbox" USING btree ("chat_id","dispatched_job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_units_uq" ON "analysis_units" USING btree ("job_id","unit_key");--> statement-breakpoint
CREATE INDEX "analysis_units_chat_idx" ON "analysis_units" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_msg_ord_uq" ON "attachments" USING btree ("message_id","ordinal");--> statement-breakpoint
CREATE INDEX "attachments_workspace_idx" ON "attachments" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_aliases_uq" ON "chat_aliases" USING btree ("workspace_id","alias_jid");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_native_uq" ON "chats" USING btree ("workspace_id","source_kind","linked_account_id","native_jid");--> statement-breakpoint
CREATE INDEX "chats_workspace_idx" ON "chats" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_msg_idx" ON "claim_evidence" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "connector_commands_pending_idx" ON "connector_commands" USING btree ("linked_account_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_commands_idem_uq" ON "connector_commands" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "control_events_key_uq" ON "control_events" USING btree ("chat_id","event_key");--> statement-breakpoint
CREATE INDEX "control_events_target_idx" ON "control_events" USING btree ("chat_id","target_native_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cross_chat_links_pair_uq" ON "cross_chat_links" USING btree ("a_topic_id","b_topic_id","relation_type");--> statement-breakpoint
CREATE INDEX "cross_chat_links_ws_idx" ON "cross_chat_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "discussions_topic_idx" ON "discussions" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_workspace_uq" ON "linked_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_native_uq" ON "messages" USING btree ("chat_id","native_key_hash");--> statement-breakpoint
CREATE INDEX "messages_chat_time_idx" ON "messages" USING btree ("chat_id","sent_at","id");--> statement-breakpoint
CREATE INDEX "messages_workspace_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_native_id_idx" ON "messages" USING btree ("chat_id","native_id");--> statement-breakpoint
CREATE INDEX "model_runs_job_idx" ON "model_runs" USING btree ("logical_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_uq" ON "participants" USING btree ("workspace_id","canonical_jid");--> statement-breakpoint
CREATE UNIQUE INDEX "placements_uq" ON "placements" USING btree ("topic_id","message_id");--> statement-breakpoint
CREATE INDEX "placements_message_idx" ON "placements" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "placements_chat_topic_idx" ON "placements" USING btree ("chat_id","topic_id");--> statement-breakpoint
CREATE INDEX "placements_discussion_idx" ON "placements" USING btree ("discussion_id");--> statement-breakpoint
CREATE INDEX "resources_message_idx" ON "resources" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "resources_canonical_idx" ON "resources" USING btree ("workspace_id","canonical_url");--> statement-breakpoint
CREATE INDEX "summary_claims_topic_idx" ON "summary_claims" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "summary_claims_disc_idx" ON "summary_claims" USING btree ("discussion_id");--> statement-breakpoint
CREATE INDEX "taxonomy_frontiers_status_idx" ON "taxonomy_frontiers" USING btree ("chat_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_frontiers_parent_uq" ON "taxonomy_frontiers" USING btree ("logical_job_id","parent_topic_id");--> statement-breakpoint
CREATE INDEX "taxonomy_overrides_chat_idx" ON "taxonomy_overrides" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "topics_tree_idx" ON "topics" USING btree ("workspace_id","chat_id","root","parent_id");--> statement-breakpoint
CREATE INDEX "topics_parent_idx" ON "topics" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_owner_mode_uq" ON "workspaces" USING btree ("owner_user_id","mode");