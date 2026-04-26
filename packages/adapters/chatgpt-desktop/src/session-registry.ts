import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_REGISTRY_PATH = join(
  homedir(),
  ".qq-codex-bridge",
  "chatgpt-session-registry.json"
);

type RegistryEntry = {
  sessionKey: string;
  threadRef: string | null;
  windowTitle: string | null;
  updatedAt: string;
};

type RegistryData = {
  version: 1;
  entries: Record<string, RegistryEntry>;
};

export class ChatgptSessionRegistry {
  private readonly path: string;
  private data: RegistryData;

  constructor(registryPath?: string) {
    this.path = registryPath ?? DEFAULT_REGISTRY_PATH;
    this.data = this.load();
  }

  private load(): RegistryData {
    if (!existsSync(this.path)) {
      return { version: 1, entries: {} };
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      return JSON.parse(raw) as RegistryData;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private save(): void {
    const dir = join(this.path, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
  }

  get(sessionKey: string): RegistryEntry | null {
    return this.data.entries[sessionKey] ?? null;
  }

  set(sessionKey: string, threadRef: string | null, windowTitle?: string | null): void {
    this.data.entries[sessionKey] = {
      sessionKey,
      threadRef,
      windowTitle: windowTitle ?? null,
      updatedAt: new Date().toISOString()
    };
    this.save();
  }

  delete(sessionKey: string): void {
    delete this.data.entries[sessionKey];
    this.save();
  }

  all(): RegistryEntry[] {
    return Object.values(this.data.entries);
  }
}
