CREATE TABLE "chat_context_summaries" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"through_position" integer NOT NULL,
	"text" text NOT NULL,
	"policy_version" text NOT NULL,
	"model_id" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "summary_revision" CHECK ("chat_context_summaries"."revision" > 0),
	CONSTRAINT "summary_position" CHECK ("chat_context_summaries"."through_position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_run_events" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "chat_run_events_run_id_sequence_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"step" integer,
	"status" text NOT NULL,
	"message" jsonb NOT NULL,
	"open_part" jsonb,
	CONSTRAINT "messages_status" CHECK (status in ('streaming', 'complete', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "chat_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_status" CHECK (status in ('running', 'completed', 'failed', 'cancelled', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"next_position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_context_summaries" ADD CONSTRAINT "chat_context_summaries_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run_events" ADD CONSTRAINT "chat_run_events_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_run_ordinal" ON "chat_messages" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_position" ON "chat_runs" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_request" ON "chat_runs" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active" ON "chat_runs" USING btree ("session_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "sessions_owner_created" ON "chat_sessions" USING btree ("owner_id","created_at");