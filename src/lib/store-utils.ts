import { randomUUID } from "crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

export function requireNonEmpty(value: unknown, fieldName: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}

export function normalizeStatus(value: unknown, fallback = "active") {
  const status = String(value === undefined || value === null || value === "" ? fallback : value).trim();
  if (status === "active" || status === "disabled") return status;
  throw new Error(`Invalid status: ${status}`);
}

export function parseJsonOr<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
