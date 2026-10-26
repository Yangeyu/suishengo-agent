import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ServiceError, type Actor, type Sessions, type Run } from "@harness";
import type { ChatChunk, ChatMessage } from "@protocol";
import { sessions, runs, messages, events } from "@plugins/sessions-pg/src/schema";

type DB = NodePgDatabase;
type TX = Parameters<Parameters<DB["transaction"]>[0]>[0];
type Reader = DB | TX;
const notFound = () => new ServiceError("NOT_FOUND", 404, "资源不存在或无权访问");

async function ownSession(db: Reader, actor: Actor, id: string) {
  const [session] = await db.select().from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.ownerId, actor.userId)));
  if (!session) throw notFound();
  return session;
}
async function ownRun(db: Reader, actor: Actor, id: string) {
  const [row] = await db.select({ run: runs }).from(runs)
    .innerJoin(sessions, eq(sessions.id, runs.sessionId))
    .where(and(eq(runs.id, id), eq(sessions.ownerId, actor.userId)));
  if (!row) throw notFound();
  return row.run;
}
function summary(row: typeof sessions.$inferSelect) {
  return { id: row.id, title: row.title, createdAt: row.createdAt.toISOString() };
}
function message(row: typeof messages.$inferSelect): ChatMessage {
  return { id: row.id, role: row.role, parts: row.parts, metadata: { runId: row.runId, schemaVersion: 1 } };
}
async function writeEvents(tx: TX, run: Run, chunks: ChatChunk[]) {
  await tx.insert(events).values(chunks.map((chunk, offset) => ({
    runId: run.id, sequence: run.sequence + offset + 1, chunk,
  })));
  await tx.update(runs).set({ sequence: run.sequence + chunks.length }).where(eq(runs.id, run.id));
}

export function createSessionStore(db: DB, limits: { global: number; perUser: number }): Sessions {
  const store: Sessions = {
    async create(actor, title) {
      const [row] = await db.insert(sessions).values({ id: randomUUID(), ownerId: actor.userId, title }).returning();
      return summary(row!);
    },
    async list(actor) {
      return (await db.select().from(sessions).where(eq(sessions.ownerId, actor.userId))
        .orderBy(desc(sessions.createdAt)).limit(100)).map(summary);
    },
    async snapshot(actor, sessionId) {
      return db.transaction(async tx => {
        const session = await ownSession(tx, actor, sessionId);
        const rows = await tx.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.position));
        const [activeRun] = await tx.select().from(runs).where(and(eq(runs.sessionId, sessionId), eq(runs.status, "running")));
        return { session: summary(session), messages: rows.map(message), activeRun: activeRun ?? null };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async admit(actor, input) {
      return db.transaction(async tx => {
        // A short admission lock makes per-user/global quotas atomic. No model/network work runs in this transaction.
        await tx.execute(sql.raw("select pg_advisory_xact_lock(726451, 2)"));
        const [session] = await tx.select().from(sessions)
          .where(and(eq(sessions.id, input.sessionId), eq(sessions.ownerId, actor.userId))).for("update");
        if (!session) throw notFound();
        const [existing] = await tx.select().from(runs)
          .where(and(eq(runs.sessionId, input.sessionId), eq(runs.requestId, input.requestId)));
        if (existing) {
          if (existing.input !== input.text || existing.userMessageId !== input.userMessageId) {
            throw new ServiceError("IDEMPOTENCY_CONFLICT", 409, "同一请求标识不能提交不同内容");
          }
          return { run: existing, created: false };
        }
        const [busy] = await tx.select().from(runs).where(and(eq(runs.sessionId, input.sessionId), eq(runs.status, "running")));
        if (busy) throw new ServiceError("SESSION_BUSY", 409, "当前会话仍在处理中");
        const active = await tx.select({ owner: sessions.ownerId }).from(runs)
          .innerJoin(sessions, eq(sessions.id, runs.sessionId)).where(eq(runs.status, "running"));
        if (active.length >= limits.global || active.filter(row => row.owner === actor.userId).length >= limits.perUser) {
          throw new ServiceError("CAPACITY_EXCEEDED", 429, "运行额度已满，请稍后重试");
        }

        const [run] = await tx.insert(runs).values({
          id: randomUUID(), sessionId: session.id, requestId: input.requestId,
          userMessageId: input.userMessageId, input: input.text,
          assistantId: randomUUID(), status: "running",
        }).returning();
        await tx.insert(messages).values([
          { id: input.userMessageId, sessionId: session.id, runId: run!.id, position: session.nextMessage,
            role: "user", parts: [{ type: "text", text: input.text }] },
          { id: run!.assistantId, sessionId: session.id, runId: run!.id, position: session.nextMessage + 1,
            role: "assistant", parts: [{ type: "text", text: "", state: "streaming" }] },
        ]);
        await tx.update(sessions).set({ nextMessage: session.nextMessage + 2 }).where(eq(sessions.id, session.id));
        await writeEvents(tx, run!, [
          { type: "start", messageId: run!.assistantId, messageMetadata: { runId: run!.id, schemaVersion: 1 } },
          { type: "text-start", id: run!.assistantId },
        ]);
        return { run: { ...run!, sequence: 2 }, created: true };
      });
    },
    async getRun(actor, runId) { return ownRun(db, actor, runId); },
    async history(actor, run) {
      await ownRun(db, actor, run.id);
      const rows = await db.select({ message: messages }).from(messages)
        .innerJoin(runs, eq(runs.id, messages.runId))
        .where(and(eq(messages.sessionId, run.sessionId),
          or(eq(runs.status, "completed"), eq(runs.id, run.id))))
        .orderBy(desc(messages.position)).limit(22);
      return rows.reverse()
        .filter(row => row.message.id !== run.assistantId)
        .map(({ message: row }) => ({
          role: row.role,
          text: row.parts.filter(part => part.type === "text").map(part => part.text).join(""),
        }));
    },
    async appendText(run, delta) {
      await db.transaction(async tx => {
        const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
        if (!current || current.status !== "running") throw new Error("Run is no longer active");
        const [row] = await tx.select().from(messages).where(eq(messages.id, run.assistantId));
        const text = row!.parts.filter(part => part.type === "text").map(part => part.text).join("") + delta;
        await tx.update(messages).set({ parts: [{ type: "text", text, state: "streaming" }] }).where(eq(messages.id, run.assistantId));
        await writeEvents(tx, current, [{ type: "text-delta", id: run.assistantId, delta }]);
      });
    },
    async finish(run, status) {
      await db.transaction(async tx => {
        const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
        if (!current || current.status !== "running") return;
        const [row] = await tx.select().from(messages).where(eq(messages.id, run.assistantId));
        const parts = row!.parts.map(part => part.type === "text" ? { ...part, state: "done" as const } : part);
        await tx.update(messages).set({ parts }).where(eq(messages.id, run.assistantId));
        const chunks: ChatChunk[] = [{ type: "text-end", id: run.assistantId }];
        if (status === "failed" || status === "interrupted") {
          chunks.push({ type: "error", errorText: status === "interrupted" ? "服务重启，本次运行已中断" : "本次运行失败，请重试" });
        }
        if (status === "cancelled") chunks.push({ type: "abort" });
        chunks.push({ type: "finish", finishReason: status === "completed" ? "stop" : "other" });
        await writeEvents(tx, current, chunks);
        await tx.update(runs).set({ status }).where(eq(runs.id, run.id));
      });
    },
    async events(actor, runId, after) {
      await ownRun(db, actor, runId);
      return db.select({ sequence: events.sequence, chunk: events.chunk }).from(events)
        .where(and(eq(events.runId, runId), gt(events.sequence, after))).orderBy(asc(events.sequence)).limit(200);
    },
    async recover() {
      const pending = await db.select().from(runs).where(eq(runs.status, "running"));
      for (const run of pending) await store.finish(run, "interrupted");
    },
  };
  return store;
}
