import { createApplication } from "@backend/application";
import { logger } from "@logging";
import { loadConfig } from "@backend/config";

let app: Awaited<ReturnType<typeof createApplication>> | undefined;
try {
  app = await createApplication(loadConfig());
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 30000);
    deadline.unref();
    void app!
      .close()
      .then(() => {
        clearTimeout(deadline);
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await app.listen();
} catch {
  await app?.close();
  logger.error(
    { event: "backend.startup_failed" },
    "Check configuration, migrations and integrations",
  );
  process.exitCode = 1;
}
