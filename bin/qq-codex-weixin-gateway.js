#!/usr/bin/env node

console.error("[OmniAgent Gateway] `qq-codex-weixin-gateway` 是兼容命令；微信运行时已并入统一 Runtime。");

import("../dist/apps/weixin-gateway/src/cli.js")
  .then(({ runCliFromProcess }) => runCliFromProcess())
  .catch((error) => {
    console.error(
      "[qq-codex-weixin-gateway] fatal:",
      error instanceof Error ? error.message : String(error)
    );
    if (error instanceof Error && error.stack) {
      console.error("  stack:", error.stack);
    }
    process.exitCode = 1;
  });
