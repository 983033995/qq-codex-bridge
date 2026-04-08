import { describe, expect, it } from "vitest";
import { bootstrap } from "../../apps/bridge-daemon/src/bootstrap.js";

describe("bootstrap integration", () => {
  it("builds the app container with orchestrator and adapters", () => {
    process.env.QQBOT_APP_ID = "app-id";
    process.env.QQBOT_CLIENT_SECRET = "secret";
    process.env.QQ_CODEX_DATABASE_PATH = ":memory:";
    process.env.CODEX_REMOTE_DEBUGGING_PORT = "9229";

    const app = bootstrap();
    try {
      expect(app.orchestrator).toBeDefined();
      expect(app.adapters.qq).toBeDefined();
      expect(app.adapters.codexDesktop).toBeDefined();
    } finally {
      app.db.close();
    }
  });
});
