import { randomUUID } from "node:crypto";

// Smoke evaluation of the deployed HTTP contract. Quality datasets/judges belong here when business tools exist.
const baseUrl = process.env.EVAL_BASE_URL ?? "http://127.0.0.1:4400";
const token = process.env.EVAL_TOKEN;
if (!token) throw new Error("EVAL_TOKEN is required; use a dedicated evaluation user");
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const sessionResponse = await fetch(baseUrl + "/api/sessions", {
  method: "POST", headers, body: JSON.stringify({ title: "HTTP smoke evaluation" }),
});
if (!sessionResponse.ok) throw new Error("Cannot create evaluation session: " + sessionResponse.status);
const session = await sessionResponse.json() as { id: string };
const id = randomUUID();
const started = performance.now();
const response = await fetch(baseUrl + "/api/chat", {
  method: "POST", headers, signal: AbortSignal.timeout(150000),
  body: JSON.stringify({ sessionId: session.id, requestId: id, message: {
    id, role: "user", parts: [{ type: "text", text: "请用一句话介绍你目前能够提供的帮助。" }],
  } }),
});
const stream = await response.text();
const runId = response.headers.get("x-run-id");
const runResponse = runId ? await fetch(baseUrl + "/api/runs/" + runId, { headers }) : undefined;
const run = runResponse?.ok ? await runResponse.json() as { status: string } : undefined;
const passed = response.ok && stream.includes("[DONE]") && run?.status === "completed";
console.log(JSON.stringify({ passed, sessionId: session.id, runId, status: run?.status, elapsedMs: Math.round(performance.now() - started) }, null, 2));
if (!passed) process.exitCode = 1;
