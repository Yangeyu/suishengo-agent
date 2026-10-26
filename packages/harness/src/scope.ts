export interface Actor {
  userId: string;
}

export interface ExecutionBudget {
  readonly remaining: number;
  record(tokens: number): void;
}

export interface RunScope {
  readonly actor: Readonly<Actor>;
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly budget: ExecutionBudget;
}
