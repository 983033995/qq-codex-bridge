import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ConfigSnapshot, ConfigStorePort } from "../../ports/src/vnext/index.js";
import { calculateConfigRevision } from "./revision.js";
import { vnextConfigSchema, type VNextConfig } from "./schema.js";

export class AtomicConfigStore implements ConfigStorePort<VNextConfig> {
  constructor(readonly filePath: string) {}

  async read(): Promise<ConfigSnapshot<VNextConfig> | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }

    const value = vnextConfigSchema.parse(JSON.parse(raw) as unknown);
    return { value, revision: calculateConfigRevision(value) };
  }

  async writeAtomic(snapshot: ConfigSnapshot<VNextConfig>): Promise<void> {
    const value = vnextConfigSchema.parse(snapshot.value);
    const revision = calculateConfigRevision(value);
    if (revision !== snapshot.revision) {
      throw new Error("Config snapshot revision does not match its content");
    }

    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    );

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, this.filePath);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async delete(): Promise<void> {
    try {
      await rm(this.filePath);
      await syncDirectory(path.dirname(this.filePath));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
