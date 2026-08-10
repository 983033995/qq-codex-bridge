import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WeixinLoginStatus } from "./login-types.js";

const persistedStatusSchema = z.enum([
  "logged_out",
  "requesting_qr",
  "awaiting_scan",
  "scanned",
  "awaiting_confirmation",
  "logged_in",
  "expired",
  "invalid"
]);

const persistedStateSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.object({
    status: persistedStatusSchema,
    updatedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    secretRef: z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/).optional()
  }).strict())
}).strict();

export type PersistedWeixinLoginState = {
  status: WeixinLoginStatus;
  updatedAt: string;
  expiresAt?: string;
  secretRef?: string;
};

export class WeixinLoginStateStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Weixin login state file path is required");
  }

  async read(): Promise<Record<string, PersistedWeixinLoginState>> {
    try {
      const parsed = persistedStateSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
      return structuredClone(parsed.accounts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Weixin login state file is invalid", { cause: error });
    }
  }

  async write(accounts: Record<string, PersistedWeixinLoginState>): Promise<void> {
    const value = persistedStateSchema.parse({ version: 1, accounts });
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
