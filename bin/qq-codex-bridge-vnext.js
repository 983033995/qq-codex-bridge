#!/usr/bin/env node

import("../dist/apps/control-daemon/src/cli.js")
  .then(({ runCliFromProcess }) => runCliFromProcess())
  .catch((error) => {
    console.error("[qq-codex-bridge-vnext] fatal:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("  stack:", error.stack);
    }
    process.exitCode = 1;
  });
