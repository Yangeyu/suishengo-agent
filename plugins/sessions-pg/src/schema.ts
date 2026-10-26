import type { RunStatus, SessionEvent } from "@harness/events";
import type { StoredMessage } from "@harness/sessions";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "chat_sessions",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    title: text().notNull(),
    nextPosition: integer("next_position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_owner_created").on(t.ownerId, t.createdAt)],
);

export const runs = pgTable(
  "chat_runs",
  {
    id: uuid().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    requestId: uuid("request_id").notNull(),
    userMessageId: uuid("user_message_id").notNull(),
    position: integer().notNull(),
    status: text().$type<RunStatus>().notNull(),
    sequence: integer().notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("runs_position").on(t.sessionId, t.position),
    uniqueIndex("runs_request").on(t.sessionId, t.requestId),
    uniqueIndex("runs_one_active").on(t.sessionId).where(sql.raw("status = 'running'")),
    check(
      "runs_status",
      sql.raw("status in ('running', 'completed', 'failed', 'cancelled', 'interrupted')"),
    ),
  ],
);

export const messages = pgTable(
  "chat_messages",
  {
    id: text().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    ordinal: integer().notNull(),
    step: integer(),
    status: text().$type<StoredMessage["status"]>().notNull(),
    message: jsonb().$type<StoredMessage["message"]>().notNull(),
    openPart: jsonb("open_part").$type<StoredMessage["openPart"]>(),
  },
  (t) => [
    uniqueIndex("messages_run_ordinal").on(t.runId, t.ordinal),
    check("messages_status", sql.raw("status in ('streaming', 'complete', 'interrupted')")),
  ],
);

export const events = pgTable(
  "chat_run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    sequence: integer().notNull(),
    event: jsonb().$type<SessionEvent>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sequence] })],
);

export const contextSummaries = pgTable(
  "chat_context_summaries",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    throughPosition: integer("through_position").notNull(),
    text: text().notNull(),
    policyVersion: text("policy_version").notNull(),
    modelId: text("model_id").notNull(),
    revision: integer().notNull(),
  },
  (t) => [
    check("summary_revision", sql`${t.revision} > 0`),
    check("summary_position", sql`${t.throughPosition} >= 0`),
  ],
);
