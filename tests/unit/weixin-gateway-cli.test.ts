import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../apps/weixin-gateway/src/cli.js";

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

describe("weixin gateway cli", () => {
  it("runs qr login flow without starting the gateway server", async () => {
    const cwd = createTempDir("qq-codex-weixin-gateway-");
    fs.writeFileSync(path.join(cwd, ".env"), "WEIXIN_ENABLED=true\n");
    const env: NodeJS.ProcessEnv = {
      WEIXIN_ENABLED: "true",
      WEIXIN_ACCOUNT_ID: "wx-main",
      WEIXIN_GATEWAY_LISTEN_HOST: "127.0.0.1",
      WEIXIN_GATEWAY_LISTEN_PORT: "3200",
      WEIXIN_GATEWAY_BRIDGE_BASE_URL: "http://127.0.0.1:3100",
      WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH: "/webhooks/weixin",
      WEIXIN_BASE_URL: "https://ilinkai.weixin.qq.com",
      WEIXIN_LOGIN_BASE_URL: "https://ilinkai.weixin.qq.com"
    };
    const io = collectWrites();
    const stateStore = {
      resolveRuntimeAccount: vi.fn().mockReturnValue(null),
      setStoredAccount: vi.fn()
    };
    const runLoginFlow = vi.fn().mockResolvedValue({
      accountId: "wx-main",
      baseUrl: "https://ilinkai.weixin.qq.com",
      qrcodeUrl: "https://example.com/qr.png"
    });
    const createServer = vi.fn();

    await expect(
      runCli(["--weixin-login"], {
        cwd,
        env,
        loadEnvFile: vi.fn(),
        createStateStore: () => stateStore as never,
        runWeixinLoginFlow: runLoginFlow,
        createServer,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr
      })
    ).resolves.toBe(0);

    expect(runLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "wx-main",
        stateStore
      })
    );
    expect(createServer).not.toHaveBeenCalled();
    expect(io.stdout.join("\n")).toContain("扫码登录");
    expect(io.stdout.join("\n")).toContain("https://example.com/qr.png");
    expect(io.stderr).toHaveLength(0);
  });
});
