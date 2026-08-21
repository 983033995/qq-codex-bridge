#!/usr/bin/env node

console.error("[OmniAgent Gateway] `qq-codex-bridge-vnext` 是兼容命令；建议迁移到 `omniagent-gateway`。");

import("../dist/apps/omniagent-gateway/src/cli.js")
  .then(({ runGatewayCli }) => runGatewayCli(process.argv.length > 2 ? process.argv.slice(2) : ["start"]))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error("[OmniAgent Gateway] fatal:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("  stack:", error.stack);
    }
    process.exitCode = 1;
  });
