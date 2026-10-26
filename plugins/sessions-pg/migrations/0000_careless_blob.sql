CREATE TABLE "chat_output_events" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"chunk" jsonb NOT NULL,
	CONSTRAINT "chat_output_events_run_id_sequence_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	CONSTRAINT "messages_role" CHECK (role in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "chat_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"input" text NOT NULL,
	"assistant_id" uuid NOT NULL,
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
	"next_message" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_output_events" ADD CONSTRAINT "chat_output_events_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_position" ON "chat_messages" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_request" ON "chat_runs" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active" ON "chat_runs" USING btree ("session_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "sessions_owner_created" ON "chat_sessions" USING btree ("owner_id","created_at");