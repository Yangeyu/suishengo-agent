import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import {
  definePrompt,
  createPromptTemplate,
  renderPrompt,
  composePrompts,
  inlinePrompt,
  promptReference,
  validatePromptInput,
} from "@harness/prompts";
import { prompts } from "@plugins/prompts/src/index";
import { createPrompts } from "@plugins/prompts/src/service";
import { promptsOptionsSchema } from "@plugins/prompts/src/config";

const definition = definePrompt({
  key: "example.instructions",
  description: "Variable contract",
  variables: ["language"],
  defaultTemplate: "Answer in {{language}}.",
});
const signal = () => new AbortController().signal;

test("module variable contracts survive remote changes and composition retains each source", () => {
  const template = createPromptTemplate(definition, "Use {{language}}.", {
    name: "example",
    version: 2,
  });
  const rendered = renderPrompt(template, { language: "{{untrusted}}" });
  assert.equal(rendered.text, "Use {{untrusted}}.");
  assert.throws(() => renderPrompt(template), /variables/);
  assert.throws(() => renderPrompt(template, { language: "中文", extra: "x" }), /variables/);
  assert.throws(() => createPromptTemplate(definition, "No variable"), /contract mismatch/);
  assert.throws(
    () => createPromptTemplate(definition, "{{language}} {{extra}}"),
    /contract mismatch/,
  );
  assert.throws(
    () => createPromptTemplate(definition, "{{language}} {{bad-name}}"),
    /contract mismatch/,
  );
  assert.deepEqual(promptReference(rendered), { name: "example", version: 2 });
  const composed = composePrompts(rendered, inlinePrompt("Keep it brief."));
  assert.deepEqual(composed.parts, rendered.parts);
  assert.equal(composed.text, rendered.text + "\n\nKeep it brief.");
  assert.equal(promptReference(composed), undefined);
  assert.throws(
    () => validatePromptInput({ ...composed, text: "silently replaced" }),
    /provenance/,
  );
});

test("bindings use one schema and reject ambiguous selectors and absent consumers", async () => {
  for (const source of [{ name: "example" }, { name: "example", version: 1, label: "production" }])
    assert.throws(() => promptsOptionsSchema.parse({ bindings: { [definition.key]: source } }));
  const options = promptsOptionsSchema.parse({
    bindings: { missing: { name: "example", version: 1 } },
  });
  assert.throws(() => createPrompts([definition], options.bindings), /no enabled consumer/);
  const local = createPrompts([definition], {});
  const snapshot = await local.resolve(signal());
  assert.equal(
    renderPrompt(snapshot[definition.key]!, { language: "中文" }).text,
    "Answer in 中文.",
  );
});

test("official Langfuse client resolves labels per run, pins versions, and rejects failed or incompatible templates", async (t) => {
  let version = 1;
  let status = 200;
  let compatible = true;
  const queries: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    assert.equal(url.pathname, "/api/public/v2/prompts/example");
    queries.push(url.searchParams);
    const selected = Number(url.searchParams.get("version") ?? version);
    response.writeHead(status, { "content-type": "application/json" }).end(
      JSON.stringify(
        status === 200
          ? {
              name: "example",
              version: selected,
              type: "text",
              config: {},
              labels: [],
              tags: [],
              prompt: compatible ? `Version ${selected}: {{language}}` : "Unexpected {{variable}}",
            }
          : { message: "unavailable" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const fixed = definePrompt({ ...definition, key: "example.fixed" });
  await ctx.plugin(prompts, {
    definitions: [definition, fixed],
    ...promptsOptionsSchema.parse({
      cacheTtlSeconds: 0,
      bindings: {
        [definition.key]: { name: "example", label: "production" },
        [fixed.key]: { name: "example", version: 4 },
      },
    }),
    connection: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      publicKey: "fixture-public",
      secretKey: "fixture-secret",
    },
  });
  const first = await ctx.prompts.resolve(signal());
  version = 2;
  const second = await ctx.prompts.resolve(signal());
  assert.equal(renderPrompt(first[definition.key]!, { language: "中文" }).text, "Version 1: 中文");
  assert.equal(
    renderPrompt(second[definition.key]!, { language: "English" }).text,
    "Version 2: English",
  );
  assert.equal(second[fixed.key]!.reference!.version, 4);
  assert.ok(queries.some((query) => query.get("label") === "production"));
  assert.ok(queries.some((query) => query.get("version") === "4"));
  assert.throws(() => {
    Object.assign(first[definition.key]!, { text: "changed" });
  }, TypeError);
  compatible = false;
  await assert.rejects(ctx.prompts.resolve(signal()), /contract mismatch/);
  status = 404;
  await assert.rejects(ctx.prompts.resolve(signal()));
  const controller = new AbortController();
  controller.abort();
  const count = queries.length;
  await assert.rejects(ctx.prompts.resolve(controller.signal), { name: "AbortError" });
  assert.equal(queries.length, count);
});
