import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WeixinWorkerSupervisor,
  type WeixinWorkerEvent
} from "../../packages/channel-weixin/src/index.js";

const supervisors: WeixinWorkerSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
});

describe("vNext Weixin worker IPC", () => {
  it("runs the real isolated worker with auth, version negotiation, heartbeat, and ping", async () => {
    const events: WeixinWorkerEvent[] = [];
    const supervisor = new WeixinWorkerSupervisor({
      workerScriptPath: path.resolve("apps/weixin-worker/src/cli.ts"),
      execArgv: ["--import", "tsx"],
      configuration: () => ({
        accounts: ["weixin:personal", "weixin:work"],
        login: {
          stateFilePath: `/tmp/qqcb-vnext-weixin-login-ipc-${process.pid}.json`,
          baseUrl: "https://ilinkai.weixin.qq.com",
          botType: "3",
          qrFetchTimeoutMs: 10_000,
          qrPollTimeoutMs: 35_000,
          qrTotalTimeoutMs: 480_000
        },
        message: {
          stateFilePath: `/tmp/qqcb-vnext-weixin-message-ipc-${process.pid}.json`,
          longPollTimeoutMs: 35_000,
          apiTimeoutMs: 15_000,
          retryDelayMs: 2_000
        }
      }),
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
      handshakeTimeoutMs: 2_000,
      pingTimeoutMs: 1_000,
      stopTimeoutMs: 1_000,
      onEvent: (event) => events.push(event)
    });
    supervisors.push(supervisor);

    await supervisor.start();
    await eventually(async () => (await supervisor.health()).status === "ready", 3_000);
    await expect(supervisor.ping()).resolves.toBeUndefined();
    expect(await supervisor.health()).toMatchObject({
      status: "ready",
      message: expect.stringContaining("2 account(s)")
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "weixin.worker.authenticated" }),
      expect.objectContaining({ type: "weixin.worker.ready" })
    ]));

    await supervisor.stop();
    expect((await supervisor.health()).status).toBe("offline");
    supervisors.splice(supervisors.indexOf(supervisor), 1);
  });
});

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
