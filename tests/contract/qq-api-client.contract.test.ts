import { describe, expect, it, vi } from "vitest";
import { QqApiClient } from "../../packages/adapters/qq/src/qq-api-client.js";

describe("qq api client", () => {
  it("fetches and caches the app access token", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const now = vi.fn(() => 1_000);
    const client = new QqApiClient("app-id", "secret", {
      fetchFn,
      now,
      authBaseUrl: "https://bots.qq.com"
    });

    await expect(client.getAccessToken()).resolves.toBe("token-1");
    await expect(client.getAccessToken()).resolves.toBe("token-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://bots.qq.com/app/getAppAccessToken",
      expect.objectContaining({
        method: "POST"
      })
    );
  });
});
