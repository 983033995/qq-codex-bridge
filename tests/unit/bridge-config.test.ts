import { describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../../apps/bridge-daemon/src/config.js";

describe("bridge config", () => {
  it("keeps legacy single qq and weixin envs as default accounts", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      WEIXIN_ENABLED: "true",
      WEIXIN_EGRESS_BASE_URL: "http://127.0.0.1:3200",
      WEIXIN_EGRESS_TOKEN: "wx-token"
    });

    expect(config.qqBot.accountId).toBe("default");
    expect(config.qqBots).toEqual([
      expect.objectContaining({
        accountId: "default",
        appId: "qq-app",
        clientSecret: "qq-secret"
      })
    ]);
    expect(config.weixinAccounts).toEqual([
      expect.objectContaining({
        accountId: "default",
        webhookPath: "/webhooks/weixin",
        egressBaseUrl: "http://127.0.0.1:3200"
      })
    ]);
    expect(config.push).toEqual({
      enabled: false,
      token: null,
      allowRemote: false,
      outboxRoot: "runtime/media/push-outbox",
      maxRequestsPerMinute: 60,
      workerPollIntervalMs: 1000,
      staleSendingAfterMs: 300000
    });
    expect(config.feishu).toEqual({
      enabled: false,
      accountId: "default",
      appId: "",
      appSecret: ""
    });
  });

  it("loads multiple qq and weixin accounts from structured env json", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "fallback-app",
      QQBOT_CLIENT_SECRET: "fallback-secret",
      QQBOTS_JSON: JSON.stringify([
        {
          accountId: "main",
          appId: "main-app",
          clientSecret: "main-secret",
          markdownSupport: true
        },
        {
          accountId: "shop",
          appId: "shop-app",
          clientSecret: "shop-secret",
          markdownSupport: false
        }
      ]),
      WEIXIN_ACCOUNTS_JSON: JSON.stringify([
        {
          accountId: "main",
          webhookPath: "/webhooks/weixin/main",
          egressBaseUrl: "http://127.0.0.1:3201",
          egressToken: "wx-main-token"
        },
        {
          accountId: "shop",
          webhookPath: "/webhooks/weixin/shop",
          egressBaseUrl: "http://127.0.0.1:3202",
          egressToken: "wx-shop-token"
        }
      ])
    });

    expect(config.qqBots.map((bot) => bot.accountId)).toEqual(["main", "shop"]);
    expect(config.qqBots[1]).toEqual(
      expect.objectContaining({
        appId: "shop-app",
        clientSecret: "shop-secret",
        markdownSupport: false
      })
    );
    expect(config.weixinAccounts.map((account) => account.accountId)).toEqual(["main", "shop"]);
    expect(config.weixinAccounts[1]).toEqual(
      expect.objectContaining({
        webhookPath: "/webhooks/weixin/shop",
        egressBaseUrl: "http://127.0.0.1:3202",
        egressToken: "wx-shop-token"
      })
    );
  });

  it("loads the unified desktop transport and maps legacy settings", () => {
    const legacy = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_DESKTOP_TRANSPORT: "dom",
      BRIDGE_CONVERSATION_PROVIDER: "chatgpt-desktop"
    });
    expect(legacy.desktopDriver.transport).toBe("cdp");
    expect(legacy.conversationProvider).toBe("codex-desktop");

    const current = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_DESKTOP_TRANSPORT: "dom",
      DESKTOP_DRIVER_TRANSPORT: "app-server",
      DESKTOP_DRIVER_PROBE_INTERVAL_MS: "60000"
    });
    expect(current.desktopDriver).toEqual({
      transport: "app-server",
      probeIntervalMs: 60000,
      selectorProfile: "v27",
      selectorFile: null,
      replyTimeoutMs: 10 * 60_000,
      staleTurnInterruptMs: 10 * 60_000
    });
  });

  it("allows configuring reply timeout and stale-turn-interrupt independently", () => {
    const independent = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_REPLY_TIMEOUT_MS: "120000",
      CODEX_STALE_TURN_INTERRUPT_MS: "900000"
    });
    expect(independent.desktopDriver.replyTimeoutMs).toBe(120000);
    expect(independent.desktopDriver.staleTurnInterruptMs).toBe(900000);

    const fallsBackToReplyTimeout = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_REPLY_TIMEOUT_MS: "120000"
    });
    expect(fallsBackToReplyTimeout.desktopDriver.staleTurnInterruptMs).toBe(120000);
  });

  it("loads a versioned or explicit Codex selector profile", () => {
    const config = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_SELECTOR_PROFILE: "v26",
      CODEX_SELECTOR_FILE: "/tmp/custom-selectors.json"
    });

    expect(config.desktopDriver.selectorProfile).toBe("v26");
    expect(config.desktopDriver.selectorFile).toBe("/tmp/custom-selectors.json");

    const defaults = loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      CODEX_SELECTOR_PROFILE: ""
    });
    expect(defaults.desktopDriver.selectorProfile).toBe("v27");
  });

  it("requires a token of at least 32 bytes when push is enabled", () => {
    expect(() => loadConfigFromEnv({
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      PUSH_ENABLED: "true",
      PUSH_TOKEN: "too-short"
    })).toThrow(/PUSH_TOKEN must contain at least 32 bytes/);
  });

  it("requires explicit remote opt-in when push is enabled off loopback", () => {
    const env = {
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      QQ_CODEX_LISTEN_HOST: "0.0.0.0",
      PUSH_ENABLED: "true",
      PUSH_TOKEN: "0123456789abcdef0123456789abcdef"
    };

    expect(() => loadConfigFromEnv(env)).toThrow(/PUSH_ALLOW_REMOTE=true/);
    expect(loadConfigFromEnv({
      ...env,
      PUSH_ALLOW_REMOTE: "true"
    }).push.allowRemote).toBe(true);
  });

  it("loads Feishu long-connection credentials only when explicitly enabled", () => {
    const base = {
      QQBOT_APP_ID: "qq-app",
      QQBOT_CLIENT_SECRET: "qq-secret",
      FEISHU_ENABLED: "true"
    };
    expect(() => loadConfigFromEnv(base)).toThrow(/FEISHU_APP_ID/);

    const config = loadConfigFromEnv({
      ...base,
      FEISHU_ACCOUNT_ID: "work",
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "feishu-secret"
    });
    expect(config.feishu).toEqual({
      enabled: true,
      accountId: "work",
      appId: "cli_test",
      appSecret: "feishu-secret"
    });
  });
});
