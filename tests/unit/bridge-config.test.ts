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
});
