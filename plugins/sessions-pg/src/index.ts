import type { Context } from "@deepseek-ai/cordis";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Sessions } from "@harness";
import { createSessionStore } from "@plugins/sessions-pg/src/store";

declare module "@deepseek-ai/cordis" {
  interface Context { sessions: Sessions }
}
export interface PostgresOptions { url: string; limits: { global: number; perUser: number } }
export const sessionsPg = {
  name: "sessions-pg",
  async apply(ctx: Context, options: PostgresOptions) {
    const pool = new pg.Pool({ connectionString: options.url, max: 10, connectionTimeoutMillis: 5000 });
    ctx.effect(() => () => pool.end());
    // Single-executor release: fail startup if another instance owns this database.
    const lease = await pool.connect();
    ctx.effect(() => () => { lease.release(true); });
    const result = await lease.query("select pg_try_advisory_lock(726451, 1) as acquired");
    if (!result.rows[0]?.acquired) throw new Error("Another Agent executor owns this database");
    lease.on("error", () => {
      // A lost lease invalidates the single-executor guarantee. Exit; startup recovery handles unfinished runs.
      console.error(JSON.stringify({ event: "database.lease_lost" }));
      process.exit(1);
    });
    pool.on("error", () => console.error(JSON.stringify({ event: "database.pool_error" })));
    const store = createSessionStore(drizzle(pool), options.limits);
    await store.recover();
    ctx.provide("sessions", store);
  },
};
