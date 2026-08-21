#!/usr/bin/env node

console.error("[OmniAgent Gateway] `qq-codex-bridge` 是兼容命令；建议迁移到 `omniagent-gateway`。");

import("../dist/apps/bridge-daemon/src/cli.js")
  .then(({ runCliFromProcess }) => runCliFromProcess())
  .catch((error) => {
    console.error("[qq-codex-bridge] fatal:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("  stack:", error.stack);
    }
    process.exitCode = 1;
  });
