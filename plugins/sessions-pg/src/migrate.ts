import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export async function migrateDatabase(url: string) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const lock = await client.query("select pg_try_advisory_lock(726451, 3) as acquired");
    if (!lock.rows[0]?.acquired) throw new Error("A migration is already running");
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)),
    });
  } finally {
    await client.end();
  }
}
