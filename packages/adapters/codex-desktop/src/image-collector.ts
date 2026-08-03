import { fileURLToPath } from "node:url";

const MEDIA_REFERENCE_PATTERN =
  /<qqmedia>([\s\S]*?)<\/qqmedia>|!\[[^\]]*\]\(([^)]+)\)/g;

export function collectMediaReferences(
  ...sources: Array<Iterable<unknown> | null | undefined>
): string[] {
  const collected: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const value of source) {
      const reference = normalizeMediaReference(value);
      if (!reference || seen.has(reference)) {
        continue;
      }
      seen.add(reference);
      collected.push(reference);
    }
  }

  return collected;
}

export function collectMediaReferencesFromText(text: string): string[] {
  const references: string[] = [];
  for (const match of text.matchAll(MEDIA_REFERENCE_PATTERN)) {
    const explicitReference = match[1]?.trim();
    if (explicitReference) {
      references.push(explicitReference);
      continue;
    }
    const markdownReference = match[2]?.trim();
    if (markdownReference && isLocalOrInlineReference(markdownReference)) {
      references.push(markdownReference);
    }
  }
  return collectMediaReferences(references);
}

export function normalizeMediaReference(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const reference = value.trim();
  if (!reference) {
    return null;
  }
  const lowerReference = reference.toLowerCase();
  if (lowerReference.startsWith("blob:")) {
    return null;
  }
  if (!lowerReference.startsWith("file://")) {
    return reference;
  }

  try {
    return fileURLToPath(reference);
  } catch {
    return null;
  }
}

function isLocalOrInlineReference(reference: string): boolean {
  const lowerReference = reference.toLowerCase();
  return reference.startsWith("/")
    || reference.startsWith("./")
    || reference.startsWith("../")
    || /^[A-Za-z]:[\\/]/.test(reference)
    || lowerReference.startsWith("file://")
    || lowerReference.startsWith("data:image/");
}
