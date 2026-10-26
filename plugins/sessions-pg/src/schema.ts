import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex, index, primaryKey, check } from "drizzle-orm/pg-core";
import type { ChatChunk, ChatMessage, RunStatus } from "@protocol";

export const sessions = pgTable("chat_sessions", {
  id: uuid().primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text().notNull(),
  nextMessage: integer("next_message").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("sessions_owner_created").on(t.ownerId, t.createdAt)]);

export const runs = pgTable("chat_runs", {
  id: uuid().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  requestId: uuid("request_id").notNull(),
  userMessageId: uuid("user_message_id").notNull(),
  input: text().notNull(),
  assistantId: uuid("assistant_id").notNull(),
  status: text().$type<RunStatus>().notNull(),
  sequence: integer().notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("runs_request").on(t.sessionId, t.requestId),
  uniqueIndex("runs_one_active").on(t.sessionId).where(sql.raw("status = 'running'")),
  check("runs_status", sql.raw("status in ('running', 'completed', 'failed', 'cancelled', 'interrupted')")),
]);

export const messages = pgTable("chat_messages", {
  id: uuid().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  runId: uuid("run_id").notNull().references(() => runs.id),
  position: integer().notNull(),
  role: text().$type<"user" | "assistant">().notNull(),
  parts: jsonb().$type<ChatMessage["parts"]>().notNull(),
}, t => [
  uniqueIndex("messages_position").on(t.sessionId, t.position),
  check("messages_role", sql.raw("role in ('user', 'assistant')")),
]);

export const events = pgTable("chat_output_events", {
  runId: uuid("run_id").notNull().references(() => runs.id),
  sequence: integer().notNull(),
  chunk: jsonb().$type<ChatChunk>().notNull(),
}, t => [primaryKey({ columns: [t.runId, t.sequence] })]);
