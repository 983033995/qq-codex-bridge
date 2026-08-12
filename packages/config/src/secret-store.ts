import { spawn } from "node:child_process";
import type { SecretStorePort } from "../../ports/src/vnext/index.js";

export class MemorySecretStore implements SecretStorePort {
  private readonly values = new Map<string, string>();

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}

export type SecurityCommandResult = { stdout: string };
export type SecurityCommandRunner = (
  args: readonly string[],
  input?: string
) => Promise<SecurityCommandResult>;

export class SecurityCommandError extends Error {
  constructor(readonly exitCode: number | null) {
    super(`macOS security command failed with exit code ${String(exitCode)}`);
    this.name = "SecurityCommandError";
  }
}

export class MacOsKeychainSecretStore implements SecretStorePort {
  private readonly service: string;
  private readonly run: SecurityCommandRunner;

  constructor(options: {
    service?: string;
    platform?: NodeJS.Platform;
    runner?: SecurityCommandRunner;
  } = {}) {
    if ((options.platform ?? process.platform) !== "darwin") {
      throw new Error("macOS Keychain secret store is only available on Darwin");
    }
    this.service = validateService(options.service ?? "com.qq-codex-bridge.vnext");
    this.run = options.runner ?? runSecurityCommand;
  }

  async get(ref: string): Promise<string | null> {
    validateRef(ref);
    try {
      const result = await this.run([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        ref,
        "-w"
      ]);
      return result.stdout.replace(/\r?\n$/, "");
    } catch (error) {
      if (error instanceof SecurityCommandError && error.exitCode === 44) {
        return null;
      }
      throw error;
    }
  }

  async set(ref: string, value: string): Promise<void> {
    validateRef(ref);
    if (!value) {
      throw new Error("Keychain secret cannot be empty");
    }
    const passwordHex = Buffer.from(value, "utf8").toString("hex");
    await this.run(["-i"], [
      "add-generic-password",
      "-U",
      "-s",
      quoteInteractiveArgument(this.service),
      "-a",
      quoteInteractiveArgument(ref),
      "-X",
      passwordHex
    ].join(" ") + "\n");
  }

  async delete(ref: string): Promise<void> {
    validateRef(ref);
    try {
      await this.run([
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        ref
      ]);
    } catch (error) {
      if (!(error instanceof SecurityCommandError && error.exitCode === 44)) {
        throw error;
      }
    }
  }
}

async function runSecurityCommand(
  args: readonly string[],
  input?: string
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      work();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("macOS security command timed out")));
    }, 10_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (code === 0) {
        finish(() => resolve({ stdout: Buffer.concat(stdout).toString("utf8") }));
      } else {
        finish(() => reject(new SecurityCommandError(code)));
      }
    });
    child.stdin.end(input);
  });
}

function validateRef(ref: string): void {
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(ref)) {
    throw new Error(`Invalid secret reference '${ref}'`);
  }
}

function validateService(service: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(service)) {
    throw new Error(`Invalid Keychain service '${service}'`);
  }
  return service;
}

function quoteInteractiveArgument(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}
