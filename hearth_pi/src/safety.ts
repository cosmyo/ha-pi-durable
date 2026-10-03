import { createHash, timingSafeEqual } from "node:crypto";

export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function insist(
  value: unknown,
  code = "invalid_request",
  status = 400,
): asserts value {
  if (!value) throw new Fault(status, code);
}
export function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  insist(value !== null && typeof value === "object" && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  insist(Object.keys(record).every((key) => keys.includes(key)));
  return record;
}
export function text(value: unknown, max: number, min = 1): string {
  insist(
    typeof value === "string" &&
      value.length >= min &&
      value.length <= max &&
      !value.includes("\u0000"),
  );
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function redactor(
  secrets: readonly string[],
): (value: string) => string {
  return (value) =>
    secrets
      .filter(Boolean)
      .reduce((s, secret) => s.split(secret).join("[REDACTED]"), value);
}
export const entityPattern = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
export const requestPattern = /^[a-zA-Z0-9_-]{8,80}$/;
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
