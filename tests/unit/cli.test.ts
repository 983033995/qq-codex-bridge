import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../apps/bridge-daemon/src/cli.js";

function createTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collectWrites() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (line: string) => {
      stdout.push(line);
    },
    writeStderr: (line: string) => {
      stderr.push(line);
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli", () => {
  it("creates .env in the current directory from the packaged template", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const packageRoot = createTempDir("qq-codex-cli-pkg-");
    fs.writeFileSync(path.join(packageRoot, ".env.example"), "QQBOT_APP_ID=demo\n");
    const io = collectWrites();

    await expect(
      runCli(["init"], {
        cwd,
        packageRoot,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe("QQBOT_APP_ID=demo\n");
    expect(io.stdout.join("\n")).toContain("已生成");
    expect(io.stderr).toHaveLength(0);
  });

  it("refuses to overwrite an existing .env file", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const packageRoot = createTempDir("qq-codex-cli-pkg-");
    fs.writeFileSync(path.join(packageRoot, ".env.example"), "QQBOT_APP_ID=demo\n");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=existing\n");
    const io = collectWrites();

    await expect(
      runCli(["init"], {
        cwd,
        packageRoot,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    expect(fs.readFileSync(path.join(cwd, ".env"), "utf8")).toBe("QQBOT_APP_ID=existing\n");
    expect(io.stderr.join("\n")).toContain("已存在");
  });

  it("loads the current directory .env before starting the bridge daemon", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=app-id\n");
    const env: NodeJS.ProcessEnv = {};
    const loadEnvFile = vi.fn(() => {
      env.QQBOT_APP_ID = "app-id";
      env.QQBOT_CLIENT_SECRET = "secret";
      env.CODEX_APP_NAME = "Codex";
      env.CODEX_REMOTE_DEBUGGING_PORT = "9229";
    });
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue({ channels: ["qq", "weixin"] });
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env,
        loadEnvFile,
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(loadEnvFile).toHaveBeenCalledWith(path.join(cwd, ".env"));
    expect(ensureCodexDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "Codex",
        remoteDebuggingPort: 9229
      })
    );
    expect(runBridgeDaemon).toHaveBeenCalledTimes(1);
    expect(io.stdout.join("\n")).toContain("channels active: qq, weixin");
  });

  it("prints actionable config errors when required env vars are missing", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env: {},
        loadEnvFile: vi.fn(),
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(1);

    expect(io.stderr.join("\n")).toContain("配置不完整");
    expect(io.stderr.join("\n")).toContain("QQBOT_APP_ID");
    expect(io.stderr.join("\n")).toContain("QQBOT_CLIENT_SECRET");
    expect(io.stderr.join("\n")).toContain("qq-codex-bridge init");
  });

  it("reports when Codex Desktop was already reachable", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=app-id\n");
    const env: NodeJS.ProcessEnv = {
      QQBOT_APP_ID: "app-id",
      QQBOT_CLIENT_SECRET: "secret"
    };
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: false });
    const runBridgeDaemon = vi.fn().mockResolvedValue(undefined);
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(io.stdout.join("\n")).toContain("launched: false");
  });

  it("reports when the cli auto-launches Codex Desktop", async () => {
    const cwd = createTempDir("qq-codex-cli-cwd-");
    fs.writeFileSync(path.join(cwd, ".env"), "QQBOT_APP_ID=app-id\n");
    const env: NodeJS.ProcessEnv = {
      QQBOT_APP_ID: "app-id",
      QQBOT_CLIENT_SECRET: "secret"
    };
    const ensureCodexDesktop = vi.fn().mockResolvedValue({ launched: true });
    const runBridgeDaemon = vi.fn().mockResolvedValue(undefined);
    const io = collectWrites();

    await expect(
      runCli([], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        ensureCodexDesktop,
        runBridgeDaemon,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(io.stdout.join("\n")).toContain("launched: true");
  });
});
