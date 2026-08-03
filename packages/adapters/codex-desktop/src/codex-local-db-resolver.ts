import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as new (
  filePath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

export type CodexDatabaseRequirement = {
  prefix: "state" | "logs";
  table: string;
  requiredColumns: readonly string[];
};

export function resolveCompatibleCodexDatabase(
  codexHomeDir: string,
  requirement: CodexDatabaseRequirement
): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(codexHomeDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const pattern = new RegExp(`^${requirement.prefix}_(\\d+)\\.sqlite$`);
  const candidates = entries
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const match = pattern.exec(entry.name);
      return match?.[1]
        ? [{ path: path.join(codexHomeDir, entry.name), version: Number(match[1]), name: entry.name }]
        : [];
    })
    .filter((candidate) => Number.isSafeInteger(candidate.version))
    .sort((left, right) => right.version - left.version || right.name.localeCompare(left.name));

  for (const candidate of candidates) {
    if (hasRequiredSchema(candidate.path, requirement)) {
      return candidate.path;
    }
  }
  return null;
}

function hasRequiredSchema(
  databasePath: string,
  requirement: CodexDatabaseRequirement
): boolean {
  let db: InstanceType<typeof BetterSqlite3> | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    const columns = db.prepare(
      `PRAGMA table_info(${quoteIdentifier(requirement.table)})`
    ).all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name).filter(Boolean));
    return requirement.requiredColumns.every((column) => names.has(column));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
