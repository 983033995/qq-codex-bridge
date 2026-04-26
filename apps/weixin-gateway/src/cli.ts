import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadWeixinGatewayConfigFromEnv } from "./config.js";
import { WeixinGatewayMessageStore } from "./message-store.js";
import { createWeixinGatewayServer } from "./server.js";
import type { MediaArtifact } from "../../../packages/domain/src/message.js";
import {
  forwardWeixinInboundToBridge,
  runWeixinLoginFlow as runWeixinLoginFlowImpl,
  WeixinClient,
  type WeixinInboundMessage
} from "./weixin-client.js";
import { WeixinGatewayStateStore, type WeixinStoredAccount } from "./state.js";

type WeixinGatewayStateStoreLike = Pick<
  WeixinGatewayStateStore,
  | "reload"
  | "getContextToken"
  | "resolveRuntimeAccount"
  | "setStoredAccount"
  | "clearStoredAccount"
>;

type WeixinClientLike = {
  accountId: string;
  baseUrl: string;
  token: string;
  ready: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  sendTextMessage(peerId: string, text: string, contextToken?: string | null): Promise<void>;
  sendMessage(target: {
    peerId: string;
    chatType: "c2c" | "group";
    content?: string;
    mediaArtifacts?: MediaArtifact[];
    contextToken?: string | null;
  }): Promise<void>;
};

type WeixinGatewayServerLike = Pick<Server, "listen" | "once" | "off" | "close">;

type CliDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  fetchFn?: typeof fetch;
  loadEnvFile?: (filePath: string) => void;
  createMessageStore?: (
    filePath: string,
    limit: number
  ) => Pick<WeixinGatewayMessageStore, "append" | "listRecent">;
  createStateStore?: (filePath: string) => WeixinGatewayStateStoreLike;
  createServer?: (deps: Parameters<typeof createWeixinGatewayServer>[0]) => WeixinGatewayServerLike;
  createWeixinClient?: (options: {
    accountId: string;
    baseUrl: string;
    token: string;
    longPollTimeoutMs: number;
    apiTimeoutMs: number;
    stateStore: WeixinGatewayStateStoreLike;
    onInboundMessage(message: WeixinInboundMessage): Promise<void>;
    fetchFn?: typeof fetch;
  }) => WeixinClientLike;
  runWeixinLoginFlow?: typeof runWeixinLoginFlowImpl;
  watchStateFile?: boolean;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
};

type StartWeixinGatewayServiceOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  fetchFn?: typeof fetch;
  loadEnvFile?: (filePath: string) => void;
  createMessageStore?: (
    filePath: string,
    limit: number
  ) => Pick<WeixinGatewayMessageStore, "append" | "listRecent">;
  createStateStore?: (filePath: string) => WeixinGatewayStateStoreLike;
  createServer?: (deps: Parameters<typeof createWeixinGatewayServer>[0]) => WeixinGatewayServerLike;
  createWeixinClient?: (options: {
    accountId: string;
    baseUrl: string;
    token: string;
    longPollTimeoutMs: number;
    apiTimeoutMs: number;
    stateStore: WeixinGatewayStateStoreLike;
    onInboundMessage(message: WeixinInboundMessage): Promise<void>;
    fetchFn?: typeof fetch;
  }) => WeixinClientLike;
  watchStateFile?: boolean;
  writeStdout?: (line: string) => void;
  writeStderr?: (line: string) => void;
};

export type WeixinGatewayServiceHandle = {
  shutdown(): Promise<void>;
  status: {
    channel: "weixin";
    enabled: boolean;
    listenHost: string;
    listenPort: number;
    loggedIn: boolean;
    accountId: string;
    accountIds: string[];
    loggedInAccountIds: string[];
  };
};

type ParsedCliArgs = {
  command: "help" | "init" | "serve" | "login" | "logout";
  accountId?: string;
  forceLogin: boolean;
};

export async function runCli(rawArgs: string[], deps: CliDeps = {}): Promise<number> {
  const args = rawArgs.filter((arg) => arg.length > 0 && arg !== "--");
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const packageRoot = deps.packageRoot ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const fetchFn = deps.fetchFn ?? fetch;
  const writeStdout = deps.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = deps.writeStderr ?? ((line: string) => console.error(line));

  const parsedArgs = parseCliArgs(args);
  if (!parsedArgs) {
    writeStderr(`[qq-codex-weixin-gateway] 未知命令：${args.join(" ")}`);
    printHelp(writeStdout);
    return 1;
  }

  if (parsedArgs.command === "init") {
    return initEnvTemplate({ cwd, packageRoot, writeStdout, writeStderr });
  }

  if (parsedArgs.command === "help") {
    printHelp(writeStdout);
    return 0;
  }

  const envFilePath = path.join(cwd, ".env");
  if (fs.existsSync(envFilePath)) {
    const loadEnvFile = deps.loadEnvFile ?? process.loadEnvFile.bind(process);
    loadEnvFile(envFilePath);
  }

  try {
    const config = loadWeixinGatewayConfigFromEnv(env);
    const stateStore =
      deps.createStateStore?.(config.stateFilePath)
      ?? new WeixinGatewayStateStore(config.stateFilePath);
    const runWeixinLoginFlow = deps.runWeixinLoginFlow ?? runWeixinLoginFlowImpl;

    const selectedAccountId = parsedArgs.accountId ?? config.accountId;
    if (parsedArgs.command === "login") {
      const result = await runWeixinLoginFlow({
        accountId: selectedAccountId,
        force: parsedArgs.forceLogin,
        onQrCode: (url) => {
          writeStdout(`[qq-codex-weixin-gateway] 二维码地址：${url}`);
          writeStdout("[qq-codex-weixin-gateway] 请在浏览器打开二维码地址并使用微信扫码确认。");
        },
        config,
        stateStore: stateStore as WeixinGatewayStateStore,
        fetchFn
      });

      if (result.qrcodeUrl) {
        writeStdout(`[qq-codex-weixin-gateway] 微信扫码登录成功，accountId=${result.accountId}`);
      } else {
        writeStdout(
          `[qq-codex-weixin-gateway] 账号 ${result.accountId} 已存在可用登录态，baseUrl=${result.baseUrl}`
        );
      }
      return 0;
    }

    if (parsedArgs.command === "logout") {
      stateStore.clearStoredAccount(selectedAccountId);
      writeStdout(`[qq-codex-weixin-gateway] 已清理账号 ${selectedAccountId} 的登录态`);
      return 0;
    }

    const service = await startWeixinGatewayService({
      cwd,
      env,
      packageRoot,
      fetchFn,
      loadEnvFile: deps.loadEnvFile,
      createMessageStore: deps.createMessageStore,
      createStateStore: deps.createStateStore,
      createServer: deps.createServer,
      createWeixinClient: deps.createWeixinClient,
      watchStateFile: deps.watchStateFile,
      writeStdout,
      writeStderr
    });

    process.once("SIGINT", () => {
      void service.shutdown().finally(() => {
        process.exit(0);
      });
    });
    process.once("SIGTERM", () => {
      void service.shutdown().finally(() => {
        process.exit(0);
      });
    });
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      writeStderr(`[qq-codex-weixin-gateway] 配置无效：${error.issues.map((issue) => issue.message).join("; ")}`);
      return 1;
    }

    writeStderr(
      `[qq-codex-weixin-gateway] fatal: ${error instanceof Error ? error.message : String(error)}`
    );
    if (error instanceof Error && error.stack) {
      writeStderr(`  stack: ${error.stack}`);
    }
    return 1;
  }
}

export async function startWeixinGatewayService(
  options: StartWeixinGatewayServiceOptions = {}
): Promise<WeixinGatewayServiceHandle> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  const fetchFn = options.fetchFn ?? fetch;
  const writeStdout = options.writeStdout ?? ((line: string) => console.log(line));
  const writeStderr = options.writeStderr ?? ((line: string) => console.error(line));
  const envFilePath = path.join(cwd, ".env");

  if (fs.existsSync(envFilePath)) {
    const loadEnvFile = options.loadEnvFile ?? process.loadEnvFile.bind(process);
    loadEnvFile(envFilePath);
  }

  void packageRoot;

  const config = loadWeixinGatewayConfigFromEnv(env);
  const createMessageStore =
    options.createMessageStore
    ?? ((filePath: string, limit: number) => new WeixinGatewayMessageStore(filePath, limit));
  const messageStores = Object.fromEntries(
    config.accounts.map((account) => [
      account.accountId,
      createMessageStore(account.messageStorePath, config.recentMessageLimit)
    ])
  );
  const messageStore = {
    append: (message: Parameters<WeixinGatewayMessageStore["append"]>[0]) => {
      const accountId = resolveOutboundAccountId({
        accountId: message.accountId,
        accountKey: message.accountKey
      }, config.accountId);
      const store = messageStores[accountId] ?? messageStores[config.accountId] ?? Object.values(messageStores)[0];
      store?.append(message);
    },
    listRecent: () =>
      Object.values(messageStores)
        .flatMap((store) => store.listRecent())
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, config.recentMessageLimit)
  };
  const stateStore =
    options.createStateStore?.(config.stateFilePath)
    ?? new WeixinGatewayStateStore(config.stateFilePath);

  const activeClients = new Map<string, WeixinClientLike>();
  const activeClientKeys = new Map<string, string>();

  const closeActiveClient = async (accountId: string) => {
    const activeClient = activeClients.get(accountId);
    if (!activeClient) {
      activeClientKeys.delete(accountId);
      return;
    }
    activeClients.delete(accountId);
    activeClientKeys.delete(accountId);
    await activeClient.close();
  };

  const resolveRuntimeAccount = (
    account: typeof config.accounts[number]
  ): WeixinStoredAccount | null =>
    stateStore.resolveRuntimeAccount(account.accountId, {
      token: account.token,
      baseUrl: account.baseUrl
    }) as WeixinStoredAccount | null;

  const createWeixinClient =
    options.createWeixinClient
    ?? ((clientOptions) =>
      new WeixinClient({
        ...clientOptions,
        stateStore: clientOptions.stateStore as WeixinGatewayStateStore,
        fetchFn: clientOptions.fetchFn
      }));

  const refreshWeixinClient = async (reason: string) => {
    const expectedAccountIds = new Set(config.accounts.map((account) => account.accountId));
    for (const account of config.accounts) {
      const runtimeAccount = resolveRuntimeAccount(account);
      const nextClientKey = runtimeAccount
        ? `${runtimeAccount.accountId}|${runtimeAccount.baseUrl}|${runtimeAccount.token}`
        : "";

      if (!runtimeAccount) {
        if (activeClients.has(account.accountId)) {
          writeStdout(`[qq-codex-weixin-gateway] 未找到微信登录态，已停用 long-poll client { accountId: ${account.accountId} }`);
          await closeActiveClient(account.accountId);
        }
        continue;
      }

      if (activeClients.has(account.accountId) && activeClientKeys.get(account.accountId) === nextClientKey) {
        continue;
      }

      await closeActiveClient(account.accountId);

      const nextClient = createWeixinClient({
        accountId: runtimeAccount.accountId,
        baseUrl: runtimeAccount.baseUrl,
        token: runtimeAccount.token,
        longPollTimeoutMs: config.longPollTimeoutMs,
        apiTimeoutMs: config.apiTimeoutMs,
        stateStore,
        fetchFn,
        onInboundMessage: async (message) => {
          await forwardWeixinInboundToBridge(fetchFn, {
            bridgeBaseUrl: config.bridgeBaseUrl,
            bridgeWebhookPath: account.bridgeWebhookPath,
            accountKey: `weixin:${account.accountId}`
          }, message);
        }
      });

      activeClients.set(account.accountId, nextClient);
      activeClientKeys.set(account.accountId, nextClientKey);
      void nextClient.connect();
      writeStdout(
        `[qq-codex-weixin-gateway] 微信 client 已连接 { reason: ${reason}, accountId: ${runtimeAccount.accountId}, baseUrl: ${runtimeAccount.baseUrl} }`
      );
    }

    for (const accountId of [...activeClients.keys()]) {
      if (!expectedAccountIds.has(accountId)) {
        await closeActiveClient(accountId);
      }
    }
  };

  const outboundSender = {
    sendTextMessage: async ({ accountKey, accountId, peerId, chatType, text, replyToMessageId }: {
      accountKey?: string;
      accountId?: string;
      peerId: string;
      chatType: "c2c" | "group";
      text: string;
      replyToMessageId?: string;
    }) => {
      const targetAccountId = resolveOutboundAccountId({ accountKey, accountId }, config.accountId);
      const activeClient = activeClients.get(targetAccountId);
      if (!activeClient) {
        throw new Error(`weixin gateway has no active logged-in client for account ${targetAccountId}`);
      }

      const contextToken = stateStore.getContextToken(activeClient.accountId, peerId);
      await activeClient.sendTextMessage(peerId, text, contextToken || null);
      console.log("[weixin-gateway] delivered outbound message", {
        accountId: targetAccountId,
        peerId,
        chatType,
        hasContextToken: Boolean(contextToken),
        replyToMessageId
      });
    },
    sendMessage: async ({ accountKey, accountId, peerId, chatType, content, mediaArtifacts, replyToMessageId }: {
      accountKey?: string;
      accountId?: string;
      peerId: string;
      chatType: "c2c" | "group";
      content?: string;
      mediaArtifacts?: MediaArtifact[];
      replyToMessageId?: string;
    }) => {
      const targetAccountId = resolveOutboundAccountId({ accountKey, accountId }, config.accountId);
      const activeClient = activeClients.get(targetAccountId);
      if (!activeClient) {
        throw new Error(`weixin gateway has no active logged-in client for account ${targetAccountId}`);
      }

      const contextToken = stateStore.getContextToken(activeClient.accountId, peerId);
      await activeClient.sendMessage({
        peerId,
        chatType,
        ...(content ? { content } : {}),
        ...(mediaArtifacts?.length ? { mediaArtifacts } : {}),
        contextToken: contextToken || null
      });
      console.log("[weixin-gateway] delivered outbound message", {
        accountId: targetAccountId,
        peerId,
        chatType,
        hasContextToken: Boolean(contextToken),
        replyToMessageId,
        mediaCount: mediaArtifacts?.length ?? 0
      });
    }
  };

  const server =
    options.createServer?.({
      config,
      messageStore,
      fetchFn,
      outboundSender
    })
    ?? createWeixinGatewayServer({
      config,
      messageStore,
      fetchFn,
      outboundSender
    });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  await refreshWeixinClient("startup");

  const shouldWatchStateFile = options.watchStateFile !== false;
  if (shouldWatchStateFile) {
    fs.watchFile(
      config.stateFilePath,
      { interval: config.stateWatchIntervalMs },
      async (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs) {
          return;
        }

        try {
          stateStore.reload();
          await refreshWeixinClient("state-file-change");
        } catch (error) {
          writeStderr(
            `[qq-codex-weixin-gateway] 刷新微信状态失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    );
  }

  writeStdout(
    `[qq-codex-weixin-gateway] ready { listenHost: ${config.listenHost}, listenPort: ${config.listenPort}, accounts: ${config.accounts.map((account) => account.accountId).join(",")}, loggedIn: ${activeClients.size} }`
  );

  return {
    shutdown: async () => {
      fs.unwatchFile(config.stateFilePath);
      await Promise.all([...activeClients.keys()].map((accountId) => closeActiveClient(accountId)));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    status: {
      channel: "weixin",
      enabled: config.enabled,
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      loggedIn: activeClients.size > 0,
      accountId: config.accountId,
      accountIds: config.accounts.map((account) => account.accountId),
      loggedInAccountIds: [...activeClients.keys()]
    }
  };
}

export async function runCliFromProcess() {
  process.exitCode = await runCli(process.argv.slice(2));
}

function initEnvTemplate(options: {
  cwd: string;
  packageRoot: string;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}) {
  const targetPath = path.join(options.cwd, ".env.weixin-gateway");
  if (fs.existsSync(targetPath)) {
    options.writeStderr(`[qq-codex-weixin-gateway] 配置文件已存在：${targetPath}`);
    return 1;
  }

  const template = [
    "WEIXIN_ENABLED=true",
    "WEIXIN_ACCOUNT_ID=default",
    "WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com",
    "# WEIXIN_TOKEN=",
    "WEIXIN_LONG_POLL_TIMEOUT_MS=35000",
    "WEIXIN_API_TIMEOUT_MS=15000",
    "WEIXIN_GATEWAY_STATE_FILE_PATH=runtime/weixin-gateway-state.json",
    "WEIXIN_LOGIN_BASE_URL=https://ilinkai.weixin.qq.com",
    "WEIXIN_BOT_TYPE=3",
    "WEIXIN_QR_FETCH_TIMEOUT_MS=10000",
    "WEIXIN_QR_POLL_TIMEOUT_MS=35000",
    "WEIXIN_QR_TOTAL_TIMEOUT_MS=480000",
    "WEIXIN_GATEWAY_STATE_WATCH_INTERVAL_MS=1000",
    "WEIXIN_GATEWAY_LISTEN_HOST=127.0.0.1",
    "WEIXIN_GATEWAY_LISTEN_PORT=3200",
    "WEIXIN_GATEWAY_BRIDGE_BASE_URL=http://127.0.0.1:3100",
    "WEIXIN_GATEWAY_BRIDGE_WEBHOOK_PATH=/webhooks/weixin",
    "# WEIXIN_GATEWAY_EXPECTED_TOKEN=your-token",
    "WEIXIN_GATEWAY_MESSAGE_STORE_PATH=runtime/weixin-gateway-messages.ndjson",
    "WEIXIN_GATEWAY_RECENT_MESSAGE_LIMIT=100",
    ""
  ].join("\n");
  fs.writeFileSync(targetPath, template, "utf8");

  options.writeStdout(`[qq-codex-weixin-gateway] 已生成真实微信网关配置：${targetPath}`);
  options.writeStdout("[qq-codex-weixin-gateway] 你也可以直接把这些变量写进项目根目录的 .env。");
  return 0;
}

function resolveOutboundAccountId(
  target: { accountKey?: string; accountId?: string },
  fallbackAccountId: string
): string {
  const explicitAccountId = String(target.accountId ?? "").trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }

  const accountKey = String(target.accountKey ?? "").trim();
  if (accountKey.startsWith("weixin:")) {
    const accountId = accountKey.slice("weixin:".length).trim();
    if (accountId) {
      return accountId;
    }
  }

  return fallbackAccountId;
}

function printHelp(writeStdout: (line: string) => void) {
  writeStdout("qq-codex-weixin-gateway");
  writeStdout("");
  writeStdout("用法：");
  writeStdout("  qq-codex-weixin-gateway                         启动真实微信网关（long-poll + 本地转发）");
  writeStdout("  qq-codex-weixin-gateway init                    生成 .env.weixin-gateway 模板");
  writeStdout("  qq-codex-weixin-gateway --weixin-login          发起微信扫码登录");
  writeStdout("  qq-codex-weixin-gateway --weixin-login-force    强制重新扫码登录");
  writeStdout("  qq-codex-weixin-gateway --weixin-logout         清理微信登录态");
  writeStdout("  qq-codex-weixin-gateway help                    查看帮助");
}

function findPackageRoot(startDir: string) {
  let currentDir = startDir;

  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

function parseCliArgs(args: string[]): ParsedCliArgs | null {
  if (args.length === 0) {
    return {
      command: "serve",
      forceLogin: false
    };
  }

  if (args.length === 1 && (args[0] === "help" || args[0] === "-h" || args[0] === "--help")) {
    return {
      command: "help",
      forceLogin: false
    };
  }

  if (args.length === 1 && args[0] === "init") {
    return {
      command: "init",
      forceLogin: false
    };
  }

  let command: ParsedCliArgs["command"] | null = null;
  let accountId: string | undefined;
  let forceLogin = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--weixin-login") {
      command = "login";
      continue;
    }
    if (arg === "--weixin-login-force") {
      command = "login";
      forceLogin = true;
      continue;
    }
    if (arg === "--weixin-logout") {
      command = "logout";
      continue;
    }
    if (arg === "--weixin-account") {
      accountId = args[index + 1];
      index += 1;
      continue;
    }
    return null;
  }

  if (!command) {
    return null;
  }

  return {
    command,
    accountId,
    forceLogin
  };
}

const isEntrypoint = (() => {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  try {
    return fileURLToPath(import.meta.url) === path.resolve(entrypoint);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void runCliFromProcess();
}
