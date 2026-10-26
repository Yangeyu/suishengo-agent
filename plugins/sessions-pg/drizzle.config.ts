import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./plugins/sessions-pg/src/schema.ts",
  out: "./plugins/sessions-pg/migrations",
});
