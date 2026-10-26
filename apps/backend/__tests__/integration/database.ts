import { migrateDatabase } from "@plugins/sessions-pg/src/migrate";

export const databaseUrl = process.env.TEST_DATABASE_URL;

export async function prepareDatabase() {
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
    throw new Error("Use a dedicated database ending in _test");
  await migrateDatabase(databaseUrl);
}
