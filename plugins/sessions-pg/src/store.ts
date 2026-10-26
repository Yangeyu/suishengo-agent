import type { ContextStore } from "@harness/context";
import type { SessionEvent } from "@harness/events";
import type { StoredMessage } from "@harness/sessions";
import { ServiceError, type Actor, type Sessions, type Run } from "@harness";
import { applySessionEvent } from "@harness/sessions/state";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, or, sql, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  sessions,
  runs,
  messages,
  events,
  contextSummaries,
} from "@plugins/sessions-pg/src/schema";

type DB = NodePgDatabase;
type TX = Parameters<Parameters<DB["transaction"]>[0]>[0];
type Reader = DB | TX;

const notFound = () => new ServiceError("NOT_FOUND", "资源不存在或无权访问");

async function ownSession(db: Reader, actor: Actor, id: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.ownerId, actor.userId)));
  if (!session) throw notFound();

  return session;
}

async function ownRun(db: Reader, actor: Actor, id: string) {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(sessions, eq(sessions.id, runs.sessionId))
    .where(and(eq(runs.id, id), eq(sessions.ownerId, actor.userId)));
  if (!row) throw notFound();

  return row.run;
}

function summary(row: typeof sessions.$inferSelect) {
  return { id: row.id, title: row.title, createdAt: row.createdAt.toISOString() };
}

function publicRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    sessionId: row.sessionId,
    requestId: row.requestId,
    userMessageId: row.userMessageId,
    position: row.position,
    status: row.status,
    sequence: row.sequence,
  };
}

function storedMessage(row: typeof messages.$inferSelect): StoredMessage {
  const { sessionId: _sessionId, ...message } = row;
  return message;
}

async function commitEvent(tx: TX, run: typeof runs.$inferSelect, event: SessionEvent) {
  const before = (
    await tx
      .select()
      .from(messages)
      .where(eq(messages.runId, run.id))
      .orderBy(asc(messages.ordinal))
  ).map(storedMessage);
  const after = applySessionEvent(before, run.id, event);

  for (const row of after) {
    if (row === before[row.ordinal]) continue;
    await tx
      .insert(messages)
      .values({ ...row, sessionId: run.sessionId })
      .onConflictDoUpdate({
        target: messages.id,
        set: { message: row.message, status: row.status, openPart: row.openPart },
      });
  }

  await tx.insert(events).values({ runId: run.id, sequence: run.sequence + 1, event });
  await tx
    .update(runs)
    .set({
      sequence: run.sequence + 1,
      ...(event.type === "run-end" ? { status: event.status } : {}),
    })
    .where(eq(runs.id, run.id));
}

export function createSessionStore(
  db: DB,
  limits: { global: number; perUser: number },
): Sessions & ContextStore {
  const store: Sessions & ContextStore = {
    async create(actor, title) {
      const [row] = await db
        .insert(sessions)
        .values({ id: randomUUID(), ownerId: actor.userId, title })
        .returning();

      return summary(row!);
    },

    async list(actor) {
      return (
        await db
          .select()
          .from(sessions)
          .where(eq(sessions.ownerId, actor.userId))
          .orderBy(desc(sessions.createdAt))
          .limit(100)
      ).map(summary);
    },

    async snapshot(actor, sessionId) {
      return db.transaction(
        async (tx) => {
          const session = await ownSession(tx, actor, sessionId);
          const turns = await tx
            .select()
            .from(runs)
            .where(eq(runs.sessionId, sessionId))
            .orderBy(asc(runs.position));
          const rows = await tx
            .select()
            .from(messages)
            .where(eq(messages.sessionId, sessionId))
            .orderBy(asc(messages.ordinal));
          const active = turns.find((run) => run.status === "running");

          return {
            session: summary(session),
            turns: turns.map((run) => ({
              run: publicRun(run),
              messages: rows.filter((row) => row.runId === run.id).map(storedMessage),
            })),
            activeRun: active ? publicRun(active) : null,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async admit(actor, input) {
      return db.transaction(async (tx) => {
        // 短事务锁保证用户与全局额度的原子校验；模型和网络调用不进入此事务。
        await tx.execute(sql.raw("select pg_advisory_xact_lock(726451, 2)"));
        const [session] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, input.sessionId), eq(sessions.ownerId, actor.userId)))
          .for("update");
        if (!session) throw notFound();

        const [existing] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.sessionId, input.sessionId), eq(runs.requestId, input.requestId)));
        if (existing) {
          const [user] = await tx
            .select()
            .from(messages)
            .where(eq(messages.id, existing.userMessageId));
          if (
            user?.message.role !== "user" ||
            user.message.text !== input.text ||
            existing.userMessageId !== input.userMessageId
          ) {
            throw new ServiceError("IDEMPOTENCY_CONFLICT", "同一请求标识不能提交不同内容");
          }
          return { run: publicRun(existing), created: false };
        }

        const [busy] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.sessionId, input.sessionId), eq(runs.status, "running")));
        if (busy) throw new ServiceError("SESSION_BUSY", "当前会话仍在处理中");

        const active = await tx
          .select({ owner: sessions.ownerId })
          .from(runs)
          .innerJoin(sessions, eq(sessions.id, runs.sessionId))
          .where(eq(runs.status, "running"));
        if (
          active.length >= limits.global ||
          active.filter((row) => row.owner === actor.userId).length >= limits.perUser
        ) {
          throw new ServiceError("CAPACITY_EXCEEDED", "运行额度已满，请稍后重试");
        }

        const [run] = await tx
          .insert(runs)
          .values({
            id: randomUUID(),
            sessionId: session.id,
            requestId: input.requestId,
            userMessageId: input.userMessageId,
            position: session.nextPosition,
            status: "running",
          })
          .returning();
        await tx.insert(messages).values({
          id: input.userMessageId,
          sessionId: session.id,
          runId: run!.id,
          ordinal: 0,
          status: "complete",
          message: { role: "user", text: input.text },
        });
        await tx
          .update(sessions)
          .set({ nextPosition: session.nextPosition + 1 })
          .where(eq(sessions.id, session.id));
        await commitEvent(tx, run!, { type: "run-start", runId: run!.id });

        return { run: { ...publicRun(run!), sequence: 1 }, created: true };
      });
    },

    async getRun(actor, runId) {
      return publicRun(await ownRun(db, actor, runId));
    },

    async history(actor, run, range = {}) {
      const owned = await ownRun(db, actor, run.id);
      // Only complete turns enter the next request; interrupted tools are never silently retried.
      const turns = await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.sessionId, owned.sessionId),
            sql`${runs.position} <= ${owned.position}`,
            range.after === undefined ? undefined : gt(runs.position, range.after),
            range.before === undefined ? undefined : lt(runs.position, range.before),
            or(eq(runs.status, "completed"), eq(runs.id, run.id)),
          ),
        )
        .orderBy(desc(runs.position))
        .limit(range.limit ?? 2147483647);
      if (!turns.length) return [];
      const rows = await db
        .select()
        .from(messages)
        .where(
          inArray(
            messages.runId,
            turns.map((turn) => turn.id),
          ),
        )
        .orderBy(asc(messages.ordinal));

      return turns.reverse().map((turn) => ({
        runId: turn.id,
        position: turn.position,
        completed: turn.status === "completed",
        messages: rows
          .filter((row) => row.runId === turn.id && row.status === "complete")
          .map((row) => row.message),
      }));
    },

    async loadSummary(actor, sessionId) {
      await ownSession(db, actor, sessionId);
      const [row] = await db
        .select()
        .from(contextSummaries)
        .where(eq(contextSummaries.sessionId, sessionId));
      return row;
    },

    async saveSummary(actor, sessionId, summary, expectedRevision, signal) {
      return db.transaction(async (tx) => {
        signal.throwIfAborted();
        await ownSession(tx, actor, sessionId);
        await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
        const [current] = await tx
          .select()
          .from(contextSummaries)
          .where(eq(contextSummaries.sessionId, sessionId));
        if ((current?.revision ?? 0) !== expectedRevision)
          throw new ServiceError("SUMMARY_CONFLICT", "摘要版本已变化");
        const [boundary] = await tx
          .select({ status: runs.status })
          .from(runs)
          .where(and(eq(runs.sessionId, sessionId), eq(runs.position, summary.throughPosition)));
        if (
          boundary?.status !== "completed" ||
          (current &&
            summary.policyVersion === current.policyVersion &&
            summary.throughPosition < current.throughPosition)
        ) {
          throw new ServiceError("SUMMARY_BOUNDARY", "摘要只能推进到已完成历史");
        }
        signal.throwIfAborted();
        const values = {
          sessionId,
          throughPosition: summary.throughPosition,
          text: summary.text,
          policyVersion: summary.policyVersion,
          modelId: summary.modelId,
          revision: expectedRevision + 1,
        };
        const [saved] = await tx
          .insert(contextSummaries)
          .values(values)
          .onConflictDoUpdate({ target: contextSummaries.sessionId, set: values })
          .returning();
        signal.throwIfAborted();
        return saved!;
      });
    },

    async append(run, event) {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
        if (!current || current.status !== "running") throw new Error("Run is no longer active");

        await commitEvent(tx, current, event);
      });
    },

    async finish(run, status) {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
        if (!current || current.status !== "running") return;

        await commitEvent(tx, current, { type: "run-end", status });
      });
    },

    async events(actor, runId, after) {
      await ownRun(db, actor, runId);

      return db
        .select({ sequence: events.sequence, event: events.event })
        .from(events)
        .where(and(eq(events.runId, runId), gt(events.sequence, after)))
        .orderBy(asc(events.sequence))
        .limit(200);
    },

    async recover() {
      const pending = await db.select().from(runs).where(eq(runs.status, "running"));
      // 进程重启不自动重放可能已产生外部副作用的运行。
      for (const run of pending) await store.finish(run, "interrupted");
    },
  };

  return store;
}
