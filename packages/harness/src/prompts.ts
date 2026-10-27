import { createHash } from "node:crypto";

/** Modules own definitions; deployments select template sources. */
export interface PromptDefinition {
  readonly key: string;
  readonly description: string;
  readonly variables: readonly string[];
  readonly defaultTemplate: string;
}

export interface PromptReference {
  readonly name: string;
  readonly version: number;
}

export interface PromptTemplate {
  readonly key: string;
  readonly text: string;
  readonly hash: string;
  readonly variables: readonly string[];
  readonly reference?: PromptReference;
}

export type PromptSnapshot = Readonly<Record<string, PromptTemplate>>;

export interface Prompts {
  /** Resolve enabled definitions once per run; labels never change within that run. */
  resolve(signal: AbortSignal): Promise<PromptSnapshot>;
}

export interface PromptPart {
  readonly key: string;
  readonly templateHash: string;
  readonly renderedHash: string;
  readonly reference?: PromptReference;
}

/** Content and provenance travel together through middleware and model adapters. */
export interface PromptInput {
  readonly text: string;
  readonly hash: string;
  readonly parts: readonly PromptPart[];
}

export function promptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function definePrompt(definition: PromptDefinition): PromptDefinition {
  if (!/^[a-z][\w-]*(\.[a-z][\w-]*)+$/.test(definition.key) || !definition.description.trim())
    throw new Error("Invalid prompt definition");
  const snapshot = Object.freeze({
    ...definition,
    variables: Object.freeze([...definition.variables]),
  });
  createPromptTemplate(snapshot, snapshot.defaultTemplate);
  return snapshot;
}

export function createPromptTemplate(
  definition: PromptDefinition,
  text: string,
  reference?: PromptReference,
): PromptTemplate {
  const names = [...new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))];
  if (
    new Set(definition.variables).size !== definition.variables.length ||
    definition.variables.some((name) => !/^\w+$/.test(name) || !names.includes(name)) ||
    names.some((name) => !definition.variables.includes(name)) ||
    /\{\{|\}\}/.test(text.replace(/\{\{\s*\w+\s*\}\}/g, ""))
  )
    throw new Error("Prompt variable contract mismatch: " + definition.key);
  return Object.freeze({
    key: definition.key,
    text,
    hash: promptHash(text),
    variables: Object.freeze([...definition.variables]),
    ...(reference ? { reference: Object.freeze({ ...reference }) } : {}),
  });
}

export function renderPrompt(
  template: PromptTemplate,
  variables: Readonly<Record<string, string>> = {},
): PromptInput {
  if (
    !template ||
    template.variables.some((name) => !Object.hasOwn(variables, name)) ||
    Object.keys(variables).some((name) => !template.variables.includes(name)) ||
    Object.values(variables).some((value) => typeof value !== "string")
  )
    throw new Error("Missing prompt template or invalid variables");
  // Substitution is single-pass: values never become template instructions.
  const text = template.text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => variables[name]!);
  const hash = promptHash(text);
  return Object.freeze({
    text,
    hash,
    parts: Object.freeze([
      Object.freeze({
        key: template.key,
        templateHash: template.hash,
        renderedHash: hash,
        ...(template.reference ? { reference: template.reference } : {}),
      }),
    ]),
  });
}

/** Explicit unversioned instructions, e.g. a local middleware contribution. */
export function inlinePrompt(text: string): PromptInput {
  return Object.freeze({ text, hash: promptHash(text), parts: Object.freeze([]) });
}

export function composePrompts(...inputs: readonly PromptInput[]): PromptInput {
  inputs.forEach(validatePromptInput);
  const text = inputs.map((input) => input.text).join("\n\n");
  return Object.freeze({
    text,
    hash: promptHash(text),
    parts: Object.freeze(inputs.flatMap((input) => input.parts)),
  });
}

export function validatePromptInput(input: PromptInput): void {
  if (input.hash !== promptHash(input.text))
    throw new Error("Prompt content and provenance disagree");
}

export function promptReference(input: PromptInput): PromptReference | undefined {
  const part = input.parts[0];
  return input.parts.length === 1 && part?.renderedHash === input.hash ? part.reference : undefined;
}

export function promptManifest(snapshot: PromptSnapshot) {
  return Object.values(snapshot).map(({ key, hash, reference }) => ({ key, hash, ...reference }));
}
