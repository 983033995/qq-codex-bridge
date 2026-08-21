import { constants } from "node:fs";
import { access, copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { GatewayPaths } from "./paths.js";

export type LegacyMigrationResult = {
  migrated: string[];
  skipped: string[];
};

const LEGACY_FILES: ReadonlyArray<{ source: string; destination: keyof GatewayPaths }> = [
  { source: "config.json", destination: "configPath" },
  { source: "runtime-vnext.db", destination: "databasePath" },
  { source: "runtime-vnext.db-wal", destination: "databasePath" },
  { source: "runtime-vnext.db-shm", destination: "databasePath" },
  { source: "weixin-login-state.json", destination: "dataDirectory" },
  { source: "weixin-message-state.json", destination: "dataDirectory" }
];

export async function prepareGatewayDirectories(paths: GatewayPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.configDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 })
  ]);
}

export async function migrateLegacyGatewayData(paths: GatewayPaths): Promise<LegacyMigrationResult> {
  await prepareGatewayDirectories(paths);
  if (paths.root === paths.legacyRoot || !(await exists(paths.legacyRoot))) {
    return { migrated: [], skipped: [] };
  }

  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const mapping of LEGACY_FILES) {
    const source = path.join(paths.legacyRoot, mapping.source);
    if (!(await isFile(source))) continue;
    const destination = legacyDestination(paths, mapping);
    if (await exists(destination)) {
      skipped.push(mapping.source);
      continue;
    }
    await atomicCopy(source, destination);
    migrated.push(mapping.source);
  }
  return { migrated, skipped };
}

function legacyDestination(
  paths: GatewayPaths,
  mapping: { source: string; destination: keyof GatewayPaths }
): string {
  if (mapping.source === "runtime-vnext.db-wal") return `${paths.databasePath}-wal`;
  if (mapping.source === "runtime-vnext.db-shm") return `${paths.databasePath}-shm`;
  const base = paths[mapping.destination];
  return mapping.destination === "dataDirectory" ? path.join(base, mapping.source) : base;
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.migration-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

async function isFile(candidate: string): Promise<boolean> {
  return stat(candidate).then((entry) => entry.isFile(), () => false);
}
