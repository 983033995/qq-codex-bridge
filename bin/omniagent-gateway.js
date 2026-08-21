#!/usr/bin/env node

import("../dist/apps/omniagent-gateway/src/cli.js")
  .then(({ runCliFromProcess }) => runCliFromProcess())
  .catch((error) => {
    console.error("[OmniAgent Gateway] fatal:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
