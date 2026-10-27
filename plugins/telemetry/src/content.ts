import type { JsonValue } from "@harness/messages";

// Keep values structured until the SDK serializes them, so nested credentials remain visible.
function bounded(value: JsonValue, depth = 0): JsonValue {
  if (depth >= 16) return "[depth limit]";
  const maxString = 16384;
  const maxItems = 128;
  if (typeof value === "string")
    return value.length > maxString ? value.slice(0, maxString) + "[truncated]" : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((item) => bounded(item, depth + 1));
    if (value.length > maxItems) items.push("[truncated]");
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, maxItems)
        .map(([key, item]) => [
          key.slice(0, 128),
          /authorization|password|secret|api[_-]?key|access[_-]?token/i.test(key)
            ? "[redacted]"
            : bounded(item, depth + 1),
        ]),
    );
  return value;
}

export function captureContent(value: JsonValue): JsonValue {
  const result = bounded(value);
  const text = JSON.stringify(result);
  return Buffer.byteLength(text) <= 65536
    ? result
    : { truncated: true, reason: "size-limit", preview: text.slice(0, 16384) };
}
