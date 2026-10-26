export function deepClone<T>(value: T): T {
  return typeof structuredClone === "function" ? structuredClone(value) : (copy(value) as T);
}

function copy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): unknown }).slice();
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [copy(k), copy(v)]));
  if (value instanceof Set) return new Set([...value].map(copy));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = copy((value as Record<string, unknown>)[key]);
  return out;
}
