import os from "node:os";
import path from "node:path";

export type GatewayPaths = {
  root: string;
  legacyRoot: string;
  runtimeDirectory: string;
  configDirectory: string;
  dataDirectory: string;
  runtimeStatePath: string;
  runtimeLockPath: string;
  pidPath: string;
  logPath: string;
  configPath: string;
  databasePath: string;
  sourceRoutingDatabasePath: string;
};

export function resolveGatewayPaths(options: {
  root?: string;
  legacyRoot?: string;
} = {}): GatewayPaths {
  const root = path.resolve(options.root ?? path.join(os.homedir(), ".omniagent-gateway"));
  const legacyRoot = path.resolve(options.legacyRoot ?? path.join(os.homedir(), ".qq-codex-bridge"));
  const runtimeDirectory = path.join(root, "runtime");
  const configDirectory = path.join(root, "config");
  const dataDirectory = path.join(root, "data");
  return {
    root,
    legacyRoot,
    runtimeDirectory,
    configDirectory,
    dataDirectory,
    runtimeStatePath: path.join(runtimeDirectory, "runtime.json"),
    runtimeLockPath: path.join(runtimeDirectory, "runtime.lock"),
    pidPath: path.join(runtimeDirectory, "bridge.pid"),
    logPath: path.join(runtimeDirectory, "bridge.log"),
    configPath: path.join(configDirectory, "config.json"),
    databasePath: path.join(dataDirectory, "gateway.sqlite"),
    sourceRoutingDatabasePath: path.join(dataDirectory, "source-routing.sqlite")
  };
}
