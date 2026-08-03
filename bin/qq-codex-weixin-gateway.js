#!/usr/bin/env node

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
