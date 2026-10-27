import type { SessionSummary } from "@frontend/types/contracts";

export type SessionAction = { kind: "rename" | "delete"; session: SessionSummary };
