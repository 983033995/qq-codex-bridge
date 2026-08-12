import { createHash } from "node:crypto";
import type { VNextConfig } from "./schema.js";

export function calculateConfigRevision(config: VNextConfig): string {
  return createHash("sha256").update(stableSerialize(config)).digest("hex");
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}
